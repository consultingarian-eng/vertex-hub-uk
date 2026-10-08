"""Startup data hygiene — heals the drift a read-only prod audit (Aug 2026) found.

Runs once per boot from `server.py _startup_work` (the same slot as
`cleanup_promoted_hires()` / `backfill_row_offices()`), and follows the same
contract: fully idempotent, every sub-step in its own try/except, never lets a
failure take the app down. One-shot steps guard themselves with a marker doc in
`data_hygiene_markers` (same pattern as the `checklist_learnt_recalc_v1` marker
in settings).

What it heals — criteria-driven, no hardcoded names or ids:
  1. Ghost hires: active new_hires stuck on Day 0/1 for 45+ days whose linked
     trainee account is gone → archived (active=False), not deleted.
  2. new_hires whose office_id matches no offices doc (e.g. a user id written
     into office_id) → healed from the linked user's office, else from the
     hire's own office-name field, else flagged for human review. Never guesses
     between offices.
  3. Push debris: expo tokens still hanging off soft-deleted users, and
     web-push subscriptions whose user is deleted/missing → stale broadcast
     targets pruned.
  4. ONE-SHOT orphan sweep: daily_assessments for hires that no longer exist,
     module_progress for hard-deleted users (soft-deleted users keep their
     history), per-office settings docs for phantom offices, and
     training_modules stranded on a phantom office (only when a same-topic
     copy exists for a real office or as a global).
  5. Indexes on the hot collections (create_index is idempotent).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from core.app_time import APP_TZ

from bson import ObjectId

logger = logging.getLogger(__name__)

# One-shot marker key for the destructive orphan sweep (step 4).
ORPHAN_MARKER = "orphan_rows_2026_08"

# Hires still on Day 0/1 after this many days with no live account are ghosts.
GHOST_STALE_DAYS = 45

# Hot-collection indexes — (collection, keys). Matched to the real query
# shapes: scoring reads delivery_checklist by assessment_id, Stage 1 screens
# read daily_assessments by (new_hire_id, day_number), bells boards key on
# (week_ending, office_id), the DataByte mirror filters (date, mc_pin),
# rosters filter (active, office_id).
_INDEXES: list[tuple[str, list[tuple[str, int]]]] = [
    ("delivery_checklist", [("assessment_id", 1)]),
    ("daily_assessments", [("new_hire_id", 1), ("day_number", 1)]),
    ("bells_entries", [("week_ending", 1), ("office_id", 1)]),
    ("owneriq_kpis", [("date", 1), ("mc_pin", 1)]),
    ("new_hires", [("active", 1), ("office_id", 1)]),
    ("notifications", [("user_id", 1), ("read", 1), ("created_at", 1)]),
    ("admin_audit_log", [("created_at", 1)]),
]


def _today_local() -> date:
    """Calendar date in app time — repo convention, never utcnow().date()."""
    return datetime.now(APP_TZ).date()


def _office_key(value) -> str:
    """Normalise an office name/key: case, spaces and hyphens are ignored,
    so 'Head Office' / 'head-office' / 'headoffice' all → 'headoffice'."""
    return str(value or "").strip().lower().replace("-", "").replace(" ", "")


async def _user_for_id(db, user_id: str) -> dict | None:
    """users lookup by the string form of its ObjectId (how every other
    collection references users). Invalid id string → no such user."""
    try:
        oid = ObjectId(user_id)
    except Exception:
        return None
    return await db.users.find_one({"_id": oid})


async def _office_maps(db) -> tuple[set, dict]:
    """(set of real office ids, normalised-name → office id). A name that
    normalises to the same key as another office is dropped from the map —
    we never guess between offices."""
    ids: set = set()
    by_key: dict = {}
    ambiguous: set = set()
    async for o in db.offices.find({}, {"_id": 0, "id": 1, "name": 1}):
        oid = o.get("id")
        if not oid:
            continue
        ids.add(oid)
        key = _office_key(o.get("name"))
        if not key:
            continue
        if key in by_key and by_key[key] != oid:
            ambiguous.add(key)
        else:
            by_key[key] = oid
    for key in ambiguous:
        by_key.pop(key, None)
    return ids, by_key


# ── 1. Ghost-hire archive ────────────────────────────────────────────────
async def _archive_ghost_hires(db, today: date | None = None) -> int:
    """Archive active new_hires stuck on Day 0/1 for 45+ days whose linked
    trainee account is missing or deleted. Repeat-safe: archiving flips
    active=False, so a healed row never matches again."""
    today = today or _today_local()
    cutoff = (today - timedelta(days=GHOST_STALE_DAYS)).isoformat()
    q = {
        "active": True,
        "start_date": {"$lt": cutoff},
        "$or": [{"current_day": None}, {"current_day": {"$in": [0, 1]}}],
    }
    archived = 0
    user_alive: dict = {}  # trainee_user_id -> account exists and not deleted
    async for hire in db.new_hires.find(q, {"_id": 1, "trainee_user_id": 1}):
        tuid = str(hire.get("trainee_user_id") or "").strip()
        if tuid:
            if tuid not in user_alive:
                user = await _user_for_id(db, tuid)
                user_alive[tuid] = bool(user) and not user.get("deleted")
            if user_alive[tuid]:
                continue  # linked account is alive — not a ghost
        await db.new_hires.update_one(
            {"_id": hire["_id"]},
            {"$set": {
                "active": False,
                "archived_reason": "auto_ghost_cleanup",
                "archived_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
        archived += 1
    if archived:
        logger.info(f"data hygiene: archived {archived} ghost new_hire row(s)")
    return archived


# ── 2. Bad office_id heal ────────────────────────────────────────────────
async def _heal_bad_office_ids(db) -> dict:
    """Active new_hires whose office_id matches no offices doc: heal from the
    linked user's office first, else from the hire's own office-name field,
    else office_id=None + needs_office_review=True. Never guesses."""
    office_ids, by_key = await _office_maps(db)
    if not office_ids:
        # Fresh/odd boot with no offices — every hire would look broken.
        logger.info("data hygiene: office heal skipped — no offices yet (normal on a brand-new database)")
        return {"healed": 0, "flagged": 0}

    healed = flagged = 0
    async for hire in db.new_hires.find({"active": True, "office_id": {"$nin": list(office_ids)}}):
        new_office = None
        # Preference 1: the linked user's office, if it is a real office.
        tuid = str(hire.get("trainee_user_id") or "").strip()
        if tuid:
            user = await _user_for_id(db, tuid)
            if user and user.get("office_id") in office_ids:
                new_office = user["office_id"]
        # Preference 2: an office-name field on the hire itself.
        if not new_office:
            for name_field in ("office_name", "office"):
                cand = by_key.get(_office_key(hire.get(name_field)))
                if cand:
                    new_office = cand
                    break
        if new_office:
            await db.new_hires.update_one(
                {"_id": hire["_id"]},
                {"$set": {"office_id": new_office}, "$unset": {"needs_office_review": ""}},
            )
            healed += 1
        else:
            if hire.get("office_id") is None and hire.get("needs_office_review"):
                continue  # already flagged on a previous boot
            await db.new_hires.update_one(
                {"_id": hire["_id"]},
                {"$set": {"office_id": None, "needs_office_review": True}},
            )
            flagged += 1
    if healed or flagged:
        logger.info(f"data hygiene: healed office_id on {healed} hire(s), flagged {flagged} for review")
    return {"healed": healed, "flagged": flagged}


# ── 3. Push-debris prune ─────────────────────────────────────────────────
async def _prune_push_debris(db) -> dict:
    """Unset expo tokens on soft-deleted users; delete web-push subscriptions
    whose user is deleted or missing. Repeat-safe by construction."""
    res = await db.users.update_many(
        {"deleted": True, "expo_push_token": {"$exists": True}},
        {"$unset": {"expo_push_token": ""}},
    )
    expo = res.modified_count or 0

    sub_uids = [u for u in await db.web_push_subscriptions.distinct("user_id") if u]
    oids = []
    for uid in sub_uids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass  # not an ObjectId string → cannot belong to a live user
    live: set = set()
    if oids:
        async for u in db.users.find({"_id": {"$in": oids}, "deleted": {"$ne": True}}, {"_id": 1}):
            live.add(str(u["_id"]))
    dead = [uid for uid in sub_uids if uid not in live]
    web = 0
    if dead:
        res2 = await db.web_push_subscriptions.delete_many({"user_id": {"$in": dead}})
        web = res2.deleted_count or 0
    if expo or web:
        logger.info(f"data hygiene: unset {expo} stale expo token(s), removed {web} dead web-push sub(s)")
    return {"expo_tokens": expo, "web_subs": web}


# ── 4. One-shot orphan-row cleanup ───────────────────────────────────────
async def _cleanup_orphan_rows(db) -> dict | None:
    """Delete rows that reference documents which no longer exist. Destructive,
    so it runs ONCE (marker `orphan_rows_2026_08`) and refuses to run at all
    if the reference collections look empty (a wiped offices/users/new_hires
    read must never cascade into mass deletion). Returns None when skipped."""
    if await db.data_hygiene_markers.find_one({"key": ORPHAN_MARKER}):
        return None  # one-shot already ran

    office_ids, _ = await _office_maps(db)
    hire_ids = {h for h in await db.new_hires.distinct("id") if h}
    have_users = await db.users.count_documents({}) > 0
    if not office_ids or not hire_ids or not have_users:
        # Safe either way (nothing is deleted); on a brand-new database this is
        # the normal first-boot state, so it isn't worth a warning.
        logger.info(
            "data hygiene: orphan cleanup skipped — offices/new starters/users not all present yet; marker NOT written"
        )
        return None

    counts = {"assessments": 0, "module_progress": 0, "settings": 0, "training_modules": 0}

    # a) daily_assessments pointing at hires that no longer exist.
    ref_ids = [x for x in await db.daily_assessments.distinct("new_hire_id") if x]
    orphan_refs = [x for x in ref_ids if x not in hire_ids]
    if orphan_refs:
        res = await db.daily_assessments.delete_many({"new_hire_id": {"$in": orphan_refs}})
        counts["assessments"] = res.deleted_count or 0

    # b) module_progress for users with NO users doc at all (hard-deleted —
    # training_routes delete_one). Soft-deleted (deleted:true) users still
    # have a doc, so their history deliberately survives a possible restore.
    prog_uids = set(await db.module_progress.distinct("target_user_id"))
    prog_uids |= set(await db.module_progress.distinct("user_id"))
    prog_uids = {x for x in prog_uids if x}
    oids = []
    for uid in prog_uids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass  # non-ObjectId string → matches no users doc
    existing: set = set()
    if oids:
        async for u in db.users.find({"_id": {"$in": oids}}, {"_id": 1}):
            existing.add(str(u["_id"]))
    missing = [uid for uid in prog_uids if uid not in existing]
    if missing:
        res = await db.module_progress.delete_many({"$or": [
            {"target_user_id": {"$in": missing}},
            {"target_user_id": {"$exists": False}, "user_id": {"$in": missing}},
        ]})
        counts["module_progress"] = res.deleted_count or 0

    # c) settings docs whose ONLY purpose is per-office config for an office
    # that no longer exists. Anything with a "key" field is a marker/singleton
    # (app_settings, checklist_learnt_recalc_v1, …) and is never touched.
    for s in await db.settings.find({}).to_list(length=10000):
        if "key" in s:
            continue
        s_office = s.get("office_id")
        if not s_office or s_office in office_ids:
            continue
        await db.settings.delete_one({"_id": s["_id"]})
        counts["settings"] += 1

    # d) training_modules stranded on a phantom office — deleted ONLY when a
    # same-topic module exists for a real office or as a global (office_id
    # None). A stranded module with no copy anywhere is content we would be
    # destroying, so it stays and gets logged instead.
    stranded_kept = 0
    for m in await db.training_modules.find(
        {}, {"_id": 1, "topic": 1, "stage": 1, "office_id": 1}
    ).to_list(length=10000):
        m_office = m.get("office_id")
        if m_office is None or m_office in office_ids:
            continue
        replacement = await db.training_modules.find_one({
            "topic": m.get("topic"),
            "stage": m.get("stage"),
            "$or": [{"office_id": {"$in": list(office_ids)}}, {"office_id": None}],
        }, {"_id": 1})
        if replacement:
            await db.training_modules.delete_one({"_id": m["_id"]})
            counts["training_modules"] += 1
        else:
            stranded_kept += 1
    if stranded_kept:
        logger.warning(
            f"data hygiene: kept {stranded_kept} stranded training_modules with no real-office/global copy"
        )

    await db.data_hygiene_markers.insert_one({
        "key": ORPHAN_MARKER,
        "ran_at": datetime.now(timezone.utc).isoformat(),
        **{f"deleted_{k}": v for k, v in counts.items()},
    })
    logger.info(f"data hygiene: one-shot orphan cleanup done {counts}")
    return counts


# ── 5. Hot-collection indexes ────────────────────────────────────────────
async def _ensure_indexes(db) -> int:
    """create_index is idempotent; collections that don't exist yet (e.g.
    notifications) are simply created with the index. Each build is guarded
    so one bad index never blocks the rest."""
    created = 0
    for coll, keys in _INDEXES:
        try:
            await db[coll].create_index(keys)
            created += 1
        except Exception as ex:
            logger.warning(f"data hygiene: create_index {coll} {keys} failed: {ex}")
    return created


# ── Entry point ──────────────────────────────────────────────────────────
async def run_data_hygiene(db) -> dict:
    """Run every hygiene step; each is individually guarded so a failure in
    one never blocks the rest (a failed step reports -1). Returns and logs a
    one-line {step: count} summary."""
    summary: dict = {}

    try:
        summary["ghost_hires_archived"] = await _archive_ghost_hires(db)
    except Exception:
        logger.exception("data hygiene: ghost-hire archive failed (continuing)")
        summary["ghost_hires_archived"] = -1

    try:
        heal = await _heal_bad_office_ids(db)
        summary["office_ids_healed"] = heal["healed"]
        summary["office_ids_flagged"] = heal["flagged"]
    except Exception:
        logger.exception("data hygiene: office_id heal failed (continuing)")
        summary["office_ids_healed"] = -1

    try:
        pruned = await _prune_push_debris(db)
        summary["push_tokens_unset"] = pruned["expo_tokens"]
        summary["web_push_subs_deleted"] = pruned["web_subs"]
    except Exception:
        logger.exception("data hygiene: push-debris prune failed (continuing)")
        summary["push_tokens_unset"] = -1

    try:
        orphans = await _cleanup_orphan_rows(db)
        summary["orphan_rows_deleted"] = sum(orphans.values()) if orphans else 0
    except Exception:
        logger.exception("data hygiene: orphan-row cleanup failed (continuing)")
        summary["orphan_rows_deleted"] = -1

    try:
        summary["indexes_ensured"] = await _ensure_indexes(db)
    except Exception:
        logger.exception("data hygiene: index ensure failed (continuing)")
        summary["indexes_ensured"] = -1

    logger.info(f"data hygiene summary: {summary}")
    return summary
