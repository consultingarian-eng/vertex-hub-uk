"""Admin endpoints: user CRUD + role changes + offices + leader-rankings + recovery tools."""
import os
import re
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from core.app_time import APP_TZ
from bson import ObjectId

from fastapi import APIRouter, HTTPException, Request

from database import db
from core import media_store
from auth import (
    hash_password, verify_password, get_current_user, require_admin,
    require_admin_or_leader, require_super_admin, get_subtree_ids, MIN_PASSWORD_LENGTH,
)
from models import (
    CreateLeaderRequest, PromoteRequest, UpdateUserNameRequest, UpdatePhoneRequest,
    UpdateUserEmailRequest, OfficeCreate,
)
from core.email_utils import (
    send_promotion_email, send_welcome_email,
    send_admin_created_account_email,
)
from core.brand import role_label
from core.push import send_push_to_user
from core.office_helpers import get_office_filter
from core.trainee_records import create_training_record, create_assessment_skeleton
from routes.badges import BADGE_NUMBER_PATTERN, _badge_number_taken

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Promotion close-out ───────────────────────────────────────────────────────
async def close_out_promoted_hire(user_doc: dict) -> bool:
    """A promoted rep is no longer a trainee: retire their new-hire record and
    auto-complete any ungraded first-8-days assessments so pulse stats,
    grading queues and 'needs attention' stop treating them as an open
    trainee. Idempotent — returns True only when something was closed."""
    uid = str(user_doc.get("_id") or user_doc.get("id") or "")
    hire = None
    if user_doc.get("new_hire_id"):
        hire = await db.new_hires.find_one({"id": user_doc["new_hire_id"]})
    if not hire and uid:
        hire = await db.new_hires.find_one({"trainee_user_id": uid, "active": True})
    if not hire or not hire.get("active"):
        return False
    await db.new_hires.update_one(
        {"id": hire["id"]},
        {"$set": {
            "active": False,
            "final_outcome": hire.get("final_outcome") or "Promoted",
            "current_status": "Completed",
            "closed_out_at": datetime.now(timezone.utc).isoformat(),
            "closed_out_reason": "promoted",
        }},
    )
    # Stamp assessment_date on rows that never had one: the sales-path
    # training cutoff reads it, and a completed-but-dateless day 8 leaves
    # the Green Week cutoff unresolvable. Dated near the actual training
    # window (start + 2 weeks), not the promotion moment — a fast-promoted
    # rep's post-training Green Weeks must still count.
    try:
        _start = datetime.strptime(str(hire.get("start_date"))[:10], "%Y-%m-%d")
        _training_end_iso = (_start + timedelta(days=13)).date().isoformat()
    except Exception:
        _training_end_iso = datetime.now(timezone.utc).date().isoformat()
    await db.daily_assessments.update_many(
        {"new_hire_id": hire["id"], "completed": {"$ne": True},
         "assessment_date": {"$in": [None, ""]}},
        {"$set": {"assessment_date": _training_end_iso}},
    )
    await db.daily_assessments.update_many(
        {"new_hire_id": hire["id"], "completed": {"$ne": True}},
        {"$set": {
            "completed": True,
            "status": "Promoted",
            "leader_notes": "Auto-completed — advanced to Stage 3",
            "auto_completed": True,
        }},
    )
    logger.info(f"closed out promoted hire: {hire.get('name')} ({hire['id']})")
    return True


async def reopen_demoted_hire(user_doc: dict) -> bool:
    """Inverse of close_out_promoted_hire, for a leader demoted back to
    trainee: reactivate the hire record and un-complete ONLY the assessments
    the promotion auto-completed (auto_completed=True) — grades a leader
    actually gave stay untouched. Only records closed for reason "promoted"
    reopen; a hire closed for a real outcome stays closed. Idempotent."""
    uid = str(user_doc.get("_id") or user_doc.get("id") or "")
    hire = None
    if user_doc.get("new_hire_id"):
        hire = await db.new_hires.find_one({"id": user_doc["new_hire_id"]})
    if not hire and uid:
        hire = await db.new_hires.find_one({"trainee_user_id": uid, "closed_out_reason": "promoted"})
    if not hire or hire.get("active") or hire.get("closed_out_reason") != "promoted":
        return False
    updates = {"active": True, "current_status": "In Progress"}
    if (hire.get("final_outcome") or "") == "Promoted":
        updates["final_outcome"] = None
    await db.new_hires.update_one(
        {"id": hire["id"]},
        {"$set": updates, "$unset": {"closed_out_at": "", "closed_out_reason": ""}},
    )
    await db.daily_assessments.update_many(
        {"new_hire_id": hire["id"], "auto_completed": True},
        {"$set": {"completed": False},
         "$unset": {"status": "", "leader_notes": "", "auto_completed": ""}},
    )
    logger.info(f"reopened demoted hire: {hire.get('name')} ({hire['id']})")
    return True


async def cleanup_promoted_hires() -> int:
    """Startup backfill: close out active new-hire records that belong to
    users who are now leaders/admins (fast-tracked promotions from before
    this rule existed). Idempotent, so it's safe on every boot."""
    n = 0
    async for u in db.users.find(
        {"role": {"$in": ["leader", "admin"]}, "deleted": {"$ne": True}},
        {"new_hire_id": 1, "name": 1},
    ):
        if await close_out_promoted_hire(u):
            n += 1
    if n:
        logger.info(f"promotion cleanup: closed out {n} stale trainee record(s)")
    return n


# ── Diagnostic: bundle-seed status ────────────────────────────────────
# Lets an admin verify on the deployed side that the bundled-content
# seeder ran successfully on first boot. Returns per-collection counts
# alongside the threshold, so we can see exactly which collections are
# above/below the auto-import line.
@router.get("/admin/team-leader-report")
async def admin_team_leader_report(request: Request):
    """Who meets the Stage 4 / Stage 5 rule, and the working behind it.

    READ-ONLY on purpose — it never writes `users.title`. See
    core/team_leader.py for why: an incomplete org chart would let an
    auto-assigning version strip titles the owner deliberately granted.
    """
    await require_super_admin(request)
    from core.team_leader import team_leader_report
    return await team_leader_report()


@router.get("/admin/seed-status")
async def admin_seed_status(request: Request):
    await require_admin(request)
    return await _seed_status()


# Older path for the same check. Admin-only too: collection sizes describe
# the business (how many people, sessions, sign-ups), so they aren't public.
# Use /health for an unauthenticated "is it up?" check.
@router.get("/health/seed-status")
async def health_seed_status(request: Request):
    await require_admin(request)
    return await _seed_status()


# ── Force-import bundled content ──────────────────────────────────────
# Manual override: wipes the requested collections on this Mongo and
# re-imports the bundled JSON. Use this when the deployed Mongo has
# stale data ABOVE the auto-seeder's threshold so the boot-time seeder
# correctly skipped it — but you actually want preview content to win.
#
# Body (optional):
#   { "collections": ["product_knowledge_topics", "training_manual"] }
# If omitted/empty → force-imports ALL collections in the seed list.
#
# Always protected from the four config collections we never auto-seed
# (offices, targets, commission_fees, agenda_scan_mappings).
@router.post("/admin/seed/force-import")
async def admin_force_import(request: Request):
    await require_super_admin(request)
    from seed_loader import COLLECTIONS as SEED_COLLECTIONS
    from seed_loader import _from_jsonable
    from pathlib import Path
    import json as _json

    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}

    seedable = {c for c, _ in SEED_COLLECTIONS}
    requested = body.get("collections") or list(seedable)
    invalid = [c for c in requested if c not in seedable]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot force-import these collections (not in seed list / protected): {invalid}",
        )

    seed_dir = Path(__file__).resolve().parents[1] / "seed"
    results = []
    for col in requested:
        json_path = seed_dir / f"{col}.json"
        if not json_path.exists():
            results.append({"collection": col, "status": "skipped", "reason": "no JSON file in bundle"})
            continue
        before = await db[col].estimated_document_count()
        try:
            raw = _json.loads(json_path.read_text(encoding="utf-8"))
            docs = [_from_jsonable(d) for d in raw]
            await db[col].delete_many({})
            CHUNK = 500
            for i in range(0, len(docs), CHUNK):
                if docs[i:i + CHUNK]:
                    await db[col].insert_many(docs[i:i + CHUNK], ordered=False)
            after = await db[col].estimated_document_count()
            results.append({
                "collection": col, "status": "imported",
                "before": before, "after": after, "json_docs": len(docs),
            })
            logger.info(f"force-import {col}: {before} → {after} ({len(docs)} from JSON)")
        except Exception as e:
            logger.exception(f"force-import {col}: failed")
            results.append({"collection": col, "status": "error", "error": str(e)})
    return {"results": results, "total_collections": len(results)}


# ── Recovery: regenerate missing assessment skeletons ──────────────────
# A bundle-sync mistakenly wiped `daily_assessments` and
# `delivery_checklist` on the deployed Mongo, so existing trainees see
# "No assessments yet" instead of the day-by-day pending grid the UI is
# meant to show. This endpoint walks every active new_hire and:
#   1. Ensures days 1-8 each have a Pending daily_assessments row.
#      Existing assessments (if any) are left untouched.
#   2. For each newly created assessment, builds delivery_checklist rows
#      from `training_manual` matching the trainee's office_id + day.
#      If no manual items exist for that office/day (e.g. a new
#      currently has no manual at all), the assessment is still created
#      so the day shows up — leaders can fill it in once the manual is
#      rebuilt.
#
# Idempotent: re-running creates nothing extra. Pass {"dry_run": true}
# in the body to preview without writing.
@router.post("/admin/recovery/regenerate-assessments")
async def regenerate_assessment_skeletons(request: Request):
    await require_super_admin(request)
    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    dry_run = bool(body.get("dry_run", False))

    DAYS = list(range(1, 9))  # days 1..8 — matches the new-hire creation flow
    BLANK = {
        "assessment_date": None, "completed": False, "completed_by": None,
        "behaviour_punctuality": None, "behaviour_engagement": None, "behaviour_image": None,
        "behaviour_coachability": None, "behaviour_attitude": None,
                    "behaviour_comfort_zones": None, "behaviour_customer_service": None,
        "skill_intro": None, "skill_presentation": None, "skill_short_story": None,
        "skill_close": None, "skill_signup": None, "skill_rehash": None,
        "kpi_introductions": None, "kpi_presentations": None, "kpi_short_stories": None,
        "kpi_closes": None, "kpi_sales": None, "leader_assisted_sales": None,
        "behaviour_score": None, "skill_score": None, "kpi_score": None,
        "checklist_grade_score": None, "overall_score": None, "status": "Pending",
        "coaching_actions": None, "biggest_weakness": None, "focus_tomorrow": None,
        "leader_notes": None,
    }

    n_hires = 0
    n_orphans_fixed = 0
    n_assessments_created = 0
    n_checklist_created = 0
    per_hire = []

    # ── Pass 1: orphaned trainee users (no new_hires row at all) ──────
    # When admins create a trainee through "Admin → Create User", earlier
    # versions of that endpoint skipped the new_hires row entirely, which
    # leaves the trainee progress UI showing "No new-hire record". Detect
    # those users and back-fill a new_hires row before the day-1..8 pass.
    async for u in db.users.find({"role": "trainee"}):
        # Already linked? Skip if their new_hire_id resolves to an active row.
        nh_id = u.get("new_hire_id")
        if nh_id:
            existing = await db.new_hires.find_one({"id": nh_id})
            if existing:
                continue
        # No row — create one so this trainee shows up on Pass 2 below.
        uid = str(u.get("_id"))
        new_hid = nh_id or str(uuid.uuid4())
        leader_name = ""
        rt = u.get("reports_to")
        if rt:
            try:
                leader_user = await db.users.find_one({"_id": ObjectId(rt)})
                if leader_user:
                    leader_name = leader_user.get("name") or ""
            except Exception:
                pass
        hire_doc = {
            "id": new_hid,
            "name": u.get("name") or u.get("email") or "BA",
            "leader": leader_name,
            "start_date": (u.get("created_at") or "")[:10] or None,
            "campaign": "",
            "phase": "Week 1", "current_day": 1, "current_status": "In Progress",
            "final_outcome": None, "active": True, "notes": "",
            "office_id": u.get("office_id"),
            "trainee_user_id": uid,
            "created_at": u.get("created_at") or datetime.now(timezone.utc).isoformat(),
        }
        if not dry_run:
            await db.new_hires.insert_one(hire_doc)
            await db.users.update_one(
                {"_id": u["_id"]},
                {"$set": {"new_hire_id": new_hid}},
            )
        n_orphans_fixed += 1

    # ── Pass 2: ensure every active hire has days 1..8 assessments ─────
    async for hire in db.new_hires.find({"active": True}):
        n_hires += 1
        hid = hire.get("id")
        if not hid:
            continue
        existing_days = set()
        async for a in db.daily_assessments.find({"new_hire_id": hid}, {"day_number": 1}):
            existing_days.add(a.get("day_number"))
        missing = [d for d in DAYS if d not in existing_days]
        if not missing:
            continue
        hire_assessments = 0
        hire_checklist = 0
        office_id = hire.get("office_id")
        for day in missing:
            aid = str(uuid.uuid4())
            doc = {
                "id": aid,
                "new_hire_id": hid,
                "new_hire_name": hire.get("name") or "",
                "day_number": day,
                **BLANK,
            }
            if not dry_run:
                await db.daily_assessments.insert_one(doc)
            hire_assessments += 1
            # Best-effort delivery_checklist build from whatever manual
            # items currently exist for this office/day.
            manual_items = await db.training_manual.find(
                {"day_number": day, "office_id": office_id}
            ).sort("sequence", 1).to_list(200)
            for item in manual_items:
                cdoc = {
                    "id": str(uuid.uuid4()),
                    "assessment_id": aid,
                    "manual_item_id": f"D{day}-{item.get('sequence', 0):02d}",
                    "topic": item.get("topic"),
                    "category": item.get("category"),
                    "confidence_expected": item.get("confidence_expected", "Understand"),
                    "taught": False,
                    "outcome_achieved": False,
                    "confidence_level": "Not yet",
                    "grade": None,
                    "grade_options": item.get("grade_options", ["Excellent", "Average", "Below Average"]),
                    "notes": None,
                }
                if not dry_run:
                    await db.delivery_checklist.insert_one(cdoc)
                hire_checklist += 1
        n_assessments_created += hire_assessments
        n_checklist_created += hire_checklist
        per_hire.append({
            "name": hire.get("name"),
            "office_id": office_id,
            "missing_days": missing,
            "assessments_created": hire_assessments,
            "checklist_created": hire_checklist,
        })

    return {
        "dry_run": dry_run,
        "active_new_hires_scanned": n_hires,
        "orphan_trainees_linked": n_orphans_fixed,
        "assessments_created": n_assessments_created,
        "checklist_rows_created": n_checklist_created,
        "per_trainee": per_hire,
    }


# ── Recovery: restore Training Manual + Modules by office NAME ────────
# When preview's office_ids don't match deployed's office_ids, the
# additive-by-id heal in seed_loader silently skips everything (it
# treats every preview row as orphaned). This endpoint instead:
#   1. Reads `_offices_reference.json` from the bundle (if present) to
#      get the source deployment's `office_id → name` map.
#   2. Builds a `name → deployed_office_id` map from THIS Mongo's
#      offices collection.
#   3. For every row in `training_manual.json` / `training_modules.json`,
#      rewrites the `office_id` to the matching deployed office (by
#      name), then upserts on the (office_id, day_number, sequence) key.
#   4. Existing rows are PRESERVED — we only insert rows that aren't
#      already there. Any office not in the JSON stays
#      completely untouched because it's not in the JSON.
#
# Body (optional):
#   {
#     "dry_run": true,                              # default: false
#     "offices": ["Head Office", "North Office"]    # default: all matched
#   }
@router.post("/admin/recovery/restore-manual")
async def restore_manual_by_name(request: Request):
    await require_super_admin(request)
    from pathlib import Path
    import json as _json

    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    dry_run = bool(body.get("dry_run", False))
    only_office_names = body.get("offices") or None  # None = all matches

    seed_dir = Path(__file__).resolve().parents[1] / "seed"
    # Optional: a bundle exported from another deployment can ship an
    # `_offices_reference.json` ([{id, name}]) so its office-keyed manual /
    # module rows can be remapped here by office NAME. Without it, passes
    # 1-2 are skipped and only the generic repairs (passes 3-4) run.
    ref_path = seed_dir / "_offices_reference.json"
    ref_offices = []
    if ref_path.exists():
        try:
            ref_offices = _json.loads(ref_path.read_text(encoding="utf-8"))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"corrupt _offices_reference.json: {e}") from e
    # preview_office_id → office_name
    src_id_to_name = {o["id"]: o["name"] for o in ref_offices if o.get("id") and o.get("name")}

    # name → deployed_office_id (lowercase-folded for tolerance)
    deployed = await db.offices.find({}, {"id": 1, "name": 1}).to_list(500)
    name_to_dst_id = {(o.get("name") or "").strip().lower(): o.get("id") for o in deployed if o.get("id")}

    # Build remap: src_id → dst_id (only for offices we can resolve by name).
    remap: dict = {}
    matched_office_summary = []
    for src_id, src_name in src_id_to_name.items():
        if only_office_names and src_name not in only_office_names:
            continue
        dst_id = name_to_dst_id.get(src_name.strip().lower())
        if dst_id:
            remap[src_id] = dst_id
            matched_office_summary.append({"name": src_name, "src_id": src_id, "dst_id": dst_id})
        else:
            matched_office_summary.append({"name": src_name, "src_id": src_id, "dst_id": None, "skipped": "no office on this Mongo with that name"})

    cfgs = [
        ("training_manual", ("office_id", "day_number", "sequence")),
        ("training_modules", ("office_id", "stage", "order_in_stage")),
    ]
    results = []
    for col, key_fields in cfgs:
        path = seed_dir / f"{col}.json"
        if not ref_offices:
            results.append({"collection": col, "status": "skipped", "reason": "no _offices_reference.json in bundle"})
            continue
        if not path.exists():
            results.append({"collection": col, "status": "skipped", "reason": "no JSON in bundle"})
            continue
        try:
            raw = _json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            results.append({"collection": col, "status": "error", "error": str(e)})
            continue
        # Tuple-key set of what's already on this Mongo (so we don't dup).
        projection = {k: 1 for k in key_fields}
        existing = set()
        async for d in db[col].find({}, projection):
            existing.add(tuple(d.get(k) for k in key_fields))
        inserted = 0
        skipped_dup = 0
        skipped_no_match = 0
        for d in raw:
            from seed_loader import _from_jsonable
            doc = _from_jsonable(d)
            src_id = doc.get("office_id")
            if src_id is None:
                # Global / office-less row (e.g. a module shared across all
                # offices) — pass through as-is, no remap needed.
                pass
            else:
                dst_id = remap.get(src_id)
                if not dst_id:
                    skipped_no_match += 1
                    continue
                doc["office_id"] = dst_id
            key = tuple(doc.get(k) for k in key_fields)
            if key in existing:
                skipped_dup += 1
                continue
            doc.pop("_id", None)
            if not dry_run:
                await db[col].insert_one(doc)
            existing.add(key)
            inserted += 1
        results.append({
            "collection": col,
            "status": "ok",
            "inserted": inserted,
            "skipped_already_present": skipped_dup,
            "skipped_office_unmatched": skipped_no_match,
        })

    # ── Pass 3: backfill new_hires.office_id from the linked user ──────
    # Older admin-create-user flows didn't always copy office_id onto the
    # hire row (it sat only on the user record). Without office_id on the
    # hire, the per-day training_manual lookup fails and trainees see
    # "0 items" per day even though the manual is fully populated.
    p3_fixed = 0
    p3_unfixable = 0
    async for hire in db.new_hires.find({"$or": [{"office_id": None}, {"office_id": {"$exists": False}}]}):
        hid = hire.get("id")
        user = None
        tuid = hire.get("trainee_user_id")
        if tuid:
            try:
                user = await db.users.find_one({"_id": ObjectId(tuid)})
            except Exception:
                user = None
        if not user:
            user = await db.users.find_one({"new_hire_id": hid})
        if user and user.get("office_id"):
            if not dry_run:
                await db.new_hires.update_one(
                    {"id": hid},
                    {"$set": {"office_id": user["office_id"]}},
                )
            p3_fixed += 1
        else:
            p3_unfixable += 1

    # ── Pass 4: rebuild empty delivery_checklists from training_manual ─
    # Now that the manual is whole again, walk every active trainee's
    # daily_assessments and, for any day whose checklist is empty, create
    # the rows from training_manual matching (office_id, day_number).
    p4_assessments_filled = 0
    p4_rows_inserted = 0
    p4_skipped_no_manual = 0
    async for hire in db.new_hires.find({"active": True}):
        hid = hire.get("id")
        office_id = hire.get("office_id")
        # In dry-run, fall back to user.office_id (we didn't write pass 3 yet).
        if not office_id and dry_run:
            tuid = hire.get("trainee_user_id")
            u = None
            if tuid:
                try:
                    u = await db.users.find_one({"_id": ObjectId(tuid)})
                except Exception:
                    u = None
            if not u:
                u = await db.users.find_one({"new_hire_id": hid})
            if u and u.get("office_id"):
                office_id = u["office_id"]
        if not office_id:
            continue
        async for a in db.daily_assessments.find({"new_hire_id": hid}):
            aid = a.get("id")
            existing = await db.delivery_checklist.count_documents({"assessment_id": aid})
            if existing > 0:
                continue
            day = a.get("day_number")
            manual = await db.training_manual.find(
                {"day_number": day, "office_id": office_id}
            ).sort("sequence", 1).to_list(200)
            if not manual:
                p4_skipped_no_manual += 1
                continue
            for item in manual:
                cdoc = {
                    "id": str(uuid.uuid4()),
                    "assessment_id": aid,
                    "manual_item_id": f"D{day}-{item.get('sequence', 0):02d}",
                    "topic": item.get("topic"),
                    "category": item.get("category"),
                    "confidence_expected": item.get("confidence_expected", "Understand"),
                    "taught": False,
                    "outcome_achieved": False,
                    "confidence_level": "Not yet",
                    "grade": None,
                    "grade_options": item.get("grade_options", ["Excellent", "Average", "Below Average"]),
                    "notes": None,
                }
                if not dry_run:
                    await db.delivery_checklist.insert_one(cdoc)
                p4_rows_inserted += 1
            p4_assessments_filled += 1

    return {
        "dry_run": dry_run,
        "offices": matched_office_summary,
        "results": results,
        "office_backfill": {
            "fixed": p3_fixed,
            "unfixable_no_user_office": p3_unfixable,
        },
        "checklist_rebuild": {
            "assessments_filled": p4_assessments_filled,
            "rows_inserted": p4_rows_inserted,
            "skipped_no_manual_for_office_day": p4_skipped_no_manual,
        },
    }


# ── Recovery: clone training_manual + training_modules between offices ─
# Use this when an office (e.g. a newly added one) has no Manual at
# all — copy an existing office's Manual rows over and assign them to
# the target office. Idempotent: if a row already exists at the target
# (same day_number + sequence), it's skipped, never overwritten.
#
# Body:
#   {
#     "source_office": "Head Office",     # office NAME on this Mongo
#     "target_office": "North Office",    # office NAME on this Mongo
#     "dry_run": true                     # default: false
#   }
#
# After running this, run /admin/recovery/restore-manual once more to
# rebuild any empty delivery_checklists for the now-populated office.
@router.post("/admin/recovery/clone-office-manual")
async def clone_office_manual(request: Request):
    await require_super_admin(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    source_name = (body.get("source_office") or "").strip()
    target_name = (body.get("target_office") or "").strip()
    dry_run = bool(body.get("dry_run", False))
    if not source_name or not target_name:
        raise HTTPException(status_code=400, detail="source_office and target_office are required (office NAMES)")
    if source_name.lower() == target_name.lower():
        raise HTTPException(status_code=400, detail="source and target must be different offices")

    # Resolve names → ids on this Mongo.
    src = await db.offices.find_one({"name": {"$regex": f"^{source_name}$", "$options": "i"}})
    dst = await db.offices.find_one({"name": {"$regex": f"^{target_name}$", "$options": "i"}})
    if not src:
        raise HTTPException(status_code=404, detail=f"source office '{source_name}' not found")
    if not dst:
        raise HTTPException(status_code=404, detail=f"target office '{target_name}' not found")
    src_id = src.get("id")
    dst_id = dst.get("id")

    cfgs = [
        ("training_manual", ("day_number", "sequence")),
        ("training_modules", ("stage", "order_in_stage")),
    ]
    results = []
    for col, key_fields in cfgs:
        # Build a set of (key_fields) tuples that ALREADY exist for the
        # target office, so we don't dup-insert if the user runs this
        # twice or if the target office had a partial manual.
        projection = {k: 1 for k in key_fields}
        existing = set()
        async for d in db[col].find({"office_id": dst_id}, projection):
            existing.add(tuple(d.get(k) for k in key_fields))
        inserted = 0
        skipped_dup = 0
        async for src_row in db[col].find({"office_id": src_id}):
            key = tuple(src_row.get(k) for k in key_fields)
            if key in existing:
                skipped_dup += 1
                continue
            new_doc = dict(src_row)
            new_doc.pop("_id", None)
            # Drop any source-office-specific id field; let Mongo assign
            # a new one. Keep the human-facing 'id' if present (UUIDs).
            if "id" in new_doc:
                new_doc["id"] = str(uuid.uuid4())
            new_doc["office_id"] = dst_id
            if not dry_run:
                await db[col].insert_one(new_doc)
            existing.add(key)
            inserted += 1
        results.append({
            "collection": col,
            "inserted": inserted,
            "skipped_already_present_on_target": skipped_dup,
        })
    return {
        "dry_run": dry_run,
        "source": {"name": src.get("name"), "id": src_id},
        "target": {"name": dst.get("name"), "id": dst_id},
        "results": results,
    }


async def _seed_status():
    from seed_loader import COLLECTIONS as SEED_COLLECTIONS
    from pathlib import Path

    seed_dir = Path(__file__).resolve().parents[1] / "seed"
    rows = []
    for col, threshold in SEED_COLLECTIONS:
        json_path = seed_dir / f"{col}.json"
        try:
            actual = await db[col].estimated_document_count()
            err = None
        except Exception:
            logger.exception("seed-status: counting %s failed", col)
            actual = -1
            err = "count failed (see the server log)"
        rows.append({
            "collection": col,
            "threshold": threshold,
            "actual": actual,
            "json_present": json_path.exists(),
            "json_size_kb": round(json_path.stat().st_size / 1024, 1) if json_path.exists() else 0,
            "ok": actual >= threshold,
            "error": err,
        })
    protected = []
    for col in ("offices", "targets", "commission_fees", "agenda_scan_mappings", "users"):
        try:
            protected.append({"collection": col, "actual": await db[col].estimated_document_count()})
        except Exception:
            protected.append({"collection": col, "actual": -1})
    return {
        "seed_dir_exists": seed_dir.exists(),
        "all_seeded": all(r["ok"] for r in rows),
        "seedable": rows,
        "protected": protected,
    }


# ── Office-scope helpers for per-user admin mutations ─────────────────
# Super-admin: may touch any user. Office admin: may only touch users in
# their own office. Leaders/trainees never reach here (require_admin gate).
# We explicitly check target existence separately so callers get a clean
# 404 vs 403 distinction.
async def _admin_can_touch_user(admin: dict, target_user: dict) -> bool:
    # The owner account is immutable to ordinary office admins. Without this,
    # an admin sharing the owner's office can delete it, change its email, or
    # make its role non-admin and lock out owner-level recovery.
    if target_user.get("is_super_admin") and not admin.get("is_super_admin"):
        return False
    if admin.get("is_super_admin"):
        return True
    admin_office = admin.get("office_id") or ""
    target_office = target_user.get("office_id") or ""
    return bool(admin_office) and admin_office == target_office


async def _guard_target_user(admin: dict, user_id: str) -> dict:
    """Return the target user doc, or raise 404/403. Looks up by Mongo
    _id first, falls back to the `id` string field — matches what the
    individual endpoints already do."""
    target = None
    try:
        target = await db.users.find_one({"_id": ObjectId(user_id)})
    except Exception:
        pass
    if not target:
        target = await db.users.find_one({"id": user_id})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if not await _admin_can_touch_user(admin, target):
        raise HTTPException(status_code=403, detail="You can only edit accounts in your own office.")
    return target


@router.delete("/admin/users/{user_id}/profile-image")
async def admin_remove_profile_image(user_id: str, request: Request):
    admin = await require_admin(request)
    target = await _guard_target_user(admin, user_id)
    await db.users.update_one({"_id": ObjectId(user_id)}, {"$unset": {"profile_image": ""}})
    await media_store.delete_avatar_url((target or {}).get("profile_image"))
    return {"message": "Profile image removed"}

def _name_key(name: str) -> str:
    return " ".join((name or "").split()).lower()


async def _name_taken(name: str, office_id: Optional[str], my_id: str) -> bool:
    """Is this name (ignoring case and spacing) already used by another live
    user in the office?"""
    parts = (name or "").split()
    if not parts:
        return False
    pattern = r"^\s*" + r"\s+".join(re.escape(p) for p in parts) + r"\s*$"
    q: dict = {"name": {"$regex": pattern, "$options": "i"}, "deleted": {"$ne": True}}
    if office_id:
        q["office_id"] = office_id
    async for u in db.users.find(q, {"_id": 1, "name": 1}):
        if str(u["_id"]) != str(my_id) and _name_key(u.get("name")) == _name_key(name):
            return True
    return False


@router.put("/users/me/name")
async def update_my_name(req: UpdateUserNameRequest, request: Request):
    """Self-rename: any authenticated user can update their own display name.
    Mirrors the side-effect logic of the admin endpoint (renames cached
    references in new_hires / daily_assessments) so leaderboards and rosters
    stay consistent without a separate DB migration."""
    me = await get_current_user(request)
    new_name = (req.name or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name cannot be empty.")
    if len(new_name) > 80:
        raise HTTPException(status_code=400, detail="Name must be 80 characters or fewer.")
    old_name = me.get("name", "")
    if _name_key(new_name) != _name_key(old_name) and await _name_taken(new_name, me.get("office_id"), me["id"]):
        # Names are display only, but OwnerIQ linking and legacy records
        # still match on them, so two people in one office never share one.
        raise HTTPException(status_code=409, detail="Someone in your office already uses that name. Add a middle initial or surname to tell you apart.")
    # get_current_user strips `_id` (only `id` remains) — me["_id"] KeyErrors.
    await db.users.update_one({"_id": ObjectId(me["id"])}, {"$set": {"name": new_name}})
    # Cascade rename to legacy cached fields so leaderboards and trainee
    # rosters reflect the change immediately (matches admin endpoint's logic).
    if me.get("role") == "leader":
        await db.new_hires.update_many({"leader_user_id": me["id"]}, {"$set": {"leader": new_name}})
        await db.new_hires.update_many(
            {"leader": old_name, "office_id": me.get("office_id"),
             "$or": [{"leader_user_id": None}, {"leader_user_id": {"$exists": False}}]},
            {"$set": {"leader": new_name}},
        )
    hire_id = me.get("new_hire_id")
    if hire_id:
        await db.new_hires.update_one({"id": hire_id}, {"$set": {"name": new_name}})
        await db.daily_assessments.update_many({"new_hire_id": hire_id}, {"$set": {"new_hire_name": new_name}})
    return {"message": "Name updated.", "name": new_name}


@router.put("/users/me/phone")
async def update_my_phone(req: UpdatePhoneRequest, request: Request):
    """Self-service phone number — shows up as a tap-to-call contact on the
    onboarding hub of anyone who reports to this user. Empty string clears it
    (e.g. someone who no longer wants to share their number)."""
    me = await get_current_user(request)
    phone = (req.phone or "").strip()
    if len(phone) > 40:
        raise HTTPException(status_code=400, detail="Phone number must be 40 characters or fewer.")
    # get_current_user strips `_id` (only `id` remains) — me["_id"] KeyErrors.
    await db.users.update_one({"_id": ObjectId(me["id"])}, {"$set": {"phone": phone}})
    return {"message": "Phone number updated.", "phone": phone}


@router.put("/admin/users/{user_id}/name")
async def update_user_name(user_id: str, req: UpdateUserNameRequest, request: Request):
    admin = await require_admin(request)
    target_user = await _guard_target_user(admin, user_id)
    old_name = target_user.get("name", "")
    new_name = req.name.strip()
    await db.users.update_one({"_id": ObjectId(user_id)}, {"$set": {"name": new_name}})
    if target_user.get("role") == "leader":
        by_id = await db.new_hires.update_many({"leader_user_id": user_id}, {"$set": {"leader": new_name}})
        result = await db.new_hires.update_many(
            {"leader": old_name, "office_id": target_user.get("office_id"),
             "$or": [{"leader_user_id": None}, {"leader_user_id": {"$exists": False}}]},
            {"$set": {"leader": new_name}},
        )
        return {"message": f"User renamed. {by_id.modified_count + result.modified_count} new-starter records updated."}
    else:
        hire_id = target_user.get("new_hire_id")
        if hire_id:
            await db.new_hires.update_one({"id": hire_id}, {"$set": {"name": new_name}})
            await db.daily_assessments.update_many({"new_hire_id": hire_id}, {"$set": {"new_hire_name": new_name}})
        return {"message": "User renamed."}


@router.put("/admin/users/{user_id}/email")
async def update_user_email(user_id: str, req: UpdateUserEmailRequest, request: Request):
    """Admin: change a user's login email. Bumps session_version so the
    old sessions end, and clears any OTP/reset codes sent to the old address."""
    admin = await require_admin(request)
    target_user = await _guard_target_user(admin, user_id)

    new_email = (req.email or "").strip().lower()
    if not new_email:
        raise HTTPException(status_code=400, detail="Email cannot be empty.")
    if len(new_email) > 254:
        raise HTTPException(status_code=400, detail="Email must be 254 characters or fewer.")
    import re as _re
    if not _re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", new_email):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")

    old_email = (target_user.get("email") or "").strip().lower()
    if new_email == old_email:
        return {"message": "No change.", "email": old_email}

    conflict = await db.users.find_one({"email": new_email})
    if conflict:
        raise HTTPException(status_code=400, detail="Another account already uses that email.")

    await db.users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {"email": new_email}, "$inc": {"session_version": 1}},
    )
    # Stale OTP/reset codes were addressed to the old email string — if that
    # address is ever reassigned to someone else, an unexpired code
    # shouldn't be redeemable against this person's account.
    await db.email_otps.delete_many({"email": old_email})
    await db.password_resets.delete_many({"email": old_email})

    return {
        "message": "Email updated.",
        "email": new_email,
        "old_email": old_email,
    }


@router.put("/admin/users/{user_id}/phone")
async def update_user_phone(user_id: str, req: UpdatePhoneRequest, request: Request):
    """Admin: set/clear another user's phone number so the whole team's
    numbers stay reachable (tap-to-call) from the admin roster. Empty string
    clears it. Scope-guarded to the admin's own office (super-admins global)."""
    admin = await require_admin(request)
    await _guard_target_user(admin, user_id)
    phone = (req.phone or "").strip()
    if len(phone) > 40:
        raise HTTPException(status_code=400, detail="Phone number must be 40 characters or fewer.")
    await db.users.update_one({"_id": ObjectId(user_id)}, {"$set": {"phone": phone}})
    return {"message": "Phone number updated.", "phone": phone}


@router.put("/admin/users/{user_id}/amplifi-codes")
async def update_user_amplifi_codes(user_id: str, request: Request):
    """Admin: link a user account to one or more rep badge numbers. The
    OwnerIQ sync matches its rows to app users by these numbers (see
    owneriq_sync._build_rep_resolvers); the badge tool keeps them in step.
    Stored on the user as `amplifi_codes` (historical field name)."""
    admin = await require_admin(request)
    await _guard_target_user(admin, user_id)
    body = await request.json()
    raw = body.get("amplifi_codes")
    if isinstance(raw, str):
        raw = [raw]
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="amplifi_codes must be a list of strings")
    import re as _re
    cleaned: list = []
    seen: set = set()
    for c in raw:
        s = str(c or "").strip().upper()
        if not s:
            continue
        if not _re.match(BADGE_NUMBER_PATTERN, s):
            raise HTTPException(status_code=400, detail=f"Invalid badge number: {s} — use 2–24 letters, numbers or dashes")
        if s in seen:
            continue
        seen.add(s)
        cleaned.append(s)
    target_user = await db.users.find_one({"_id": ObjectId(user_id)})
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    # One badge number, one live person: a number is what links someone to
    # their OwnerIQ rows.
    already = {str(c).strip().upper() for c in (target_user.get("amplifi_codes") or [])}
    for s in cleaned:
        if s not in already and await _badge_number_taken(s, target_user):
            raise HTTPException(status_code=409, detail=f"Badge number {s} already belongs to someone else.")
    await db.users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {"amplifi_codes": cleaned, "amplifi_codes_updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"id": target_user.get("id"), "amplifi_codes": cleaned}


# The only office fields any signed-in screen needs (pickers, the Offices
# list). Never widen this to the whole document: office docs carry the Bells
# share code and other settings that only their own admin endpoints return.
OFFICE_PUBLIC_FIELDS = {"_id": 0, "id": 1, "name": 1, "city": 1, "state": 1}


@router.get("/offices")
async def get_offices(request: Request):
    await get_current_user(request)
    offices = await db.offices.find({}, OFFICE_PUBLIC_FIELDS).to_list(100)
    return offices

@router.post("/offices")
async def create_office(req: OfficeCreate, request: Request):
    admin = await get_current_user(request)
    if not admin.get("is_super_admin"):
        raise HTTPException(status_code=403, detail="Super admin required")
    new_office_id = str(uuid.uuid4())
    office = {"id": new_office_id, "name": req.name, "city": req.city, "state": req.state, "created_at": datetime.now(timezone.utc).isoformat()}
    await db.offices.insert_one(office)

    # Pick a template office to clone content from (training manual,
    # modules, targets, etc.): the oldest office on this database — normally
    # the one seeded on first boot.
    template_office = await db.offices.find_one(
        {"id": {"$ne": new_office_id}}, sort=[("created_at", 1)]
    )

    cloned_summary: dict[str, int] = {}
    if template_office:
        template_id = template_office["id"]
        # NOTE: training_modules is included so Stage 1-4 content carries over
        # to every new office automatically.
        for coll_name in ['training_manual', 'training_modules', 'targets', 'commission_fees', 'settings']:
            coll = db[coll_name]
            docs = await coll.find({"office_id": template_id}).to_list(2000)
            if not docs:
                cloned_summary[coll_name] = 0
                continue
            clones = []
            for doc in docs:
                clone = {k: v for k, v in doc.items() if k != '_id'}
                # Re-issue UUIDs on the human-facing 'id' field so we don't
                # collide with the source office's docs.
                if 'id' in clone:
                    clone['id'] = str(uuid.uuid4())
                clone['office_id'] = new_office_id
                clones.append(clone)
            await coll.insert_many(clones)
            cloned_summary[coll_name] = len(clones)
            logger.info(
                f"Cloned {len(clones)} {coll_name} docs from "
                f"'{template_office.get('name')}' to new office '{req.name}'"
            )
    return {
        "message": "Office created with full content template",
        "id": new_office_id,
        "template_office": (template_office or {}).get("name"),
        "cloned": cloned_summary,
    }

@router.delete("/offices/{office_id}")
async def delete_office(office_id: str, request: Request):
    admin = await get_current_user(request)
    if not admin.get("is_super_admin"):
        raise HTTPException(status_code=403, detail="Super admin required")
    await db.offices.delete_one({"id": office_id})
    # Cascade: remove orphaned office-scoped content so it doesn't bleed into other offices' new hires
    tm = await db.training_manual.delete_many({"office_id": office_id})
    tg = await db.targets.delete_many({"office_id": office_id})
    cf = await db.commission_fees.delete_many({"office_id": office_id})
    logger.info(f"Office {office_id} deleted; cascaded training_manual={tm.deleted_count}, targets={tg.deleted_count}, commission_fees={cf.deleted_count}")
    return {"message": "Office deleted"}

@router.put("/admin/users/{user_id}/offices")
async def update_user_offices(user_id: str, request: Request):
    admin = await get_current_user(request)
    if not admin.get("is_super_admin"):
        raise HTTPException(status_code=403, detail="Super admin required")
    body = await request.json()
    update = {}
    if "office_id" in body:
        update["office_id"] = body["office_id"]
    if "accessible_offices" in body:
        update["accessible_offices"] = body["accessible_offices"]
    if update:
        await db.users.update_one({"_id": ObjectId(user_id)}, {"$set": update})
    return {"message": "User offices updated"}


@router.post("/admin/create-leader")
async def create_leader(req: CreateLeaderRequest, request: Request):
    admin = await require_admin(request)
    user = await get_current_user(request)
    email = req.email.strip().lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already registered")
    leader_data = {
        "email": email, "password_hash": hash_password(req.password),
        "name": req.name.strip(), "role": "leader",
        "office_id": user.get("office_id"),
        "email_verified": True,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    result = await db.users.insert_one(leader_data)
    return {"id": str(result.inserted_id), "email": email, "name": req.name.strip(), "role": "leader"}


# ──────────────────────────────────────────────────────────────────────────
# Admin "Add User" — creates a leader OR trainee directly, no OTP / email
# verification step. Optionally auto-emails the credentials to the new user.
# ──────────────────────────────────────────────────────────────────────────
@router.post("/admin/create-user")
async def admin_create_user(request: Request):
    admin = await require_admin(request)
    actor = await get_current_user(request)
    body = await request.json()

    name = (body.get("name") or "").strip()
    email = (body.get("email") or "").strip().lower()
    password = (body.get("password") or "").strip()
    role = (body.get("role") or "trainee").strip().lower()
    reports_to = (body.get("reports_to") or "").strip() or None
    send_email_flag = bool(body.get("send_email", True))

    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Valid email is required")
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    if role not in ("leader", "trainee"):
        raise HTTPException(status_code=400, detail="Role must be 'leader' (Coach) or 'trainee' (BA)")
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already registered")

    # Inherit office from the admin creating the user. Only the owner may
    # explicitly provision another office.
    requested_office_id = (body.get("office_id") or "").strip() or None
    if requested_office_id and not actor.get("is_super_admin"):
        if requested_office_id != actor.get("office_id"):
            raise HTTPException(status_code=403, detail="You can only create users in your own office.")
    office_id = requested_office_id or actor.get("office_id") or None
    if not office_id:
        raise HTTPException(status_code=400, detail="An office is required")
    if not await db.offices.find_one({"id": office_id}, {"_id": 1}):
        raise HTTPException(status_code=400, detail="Office not found")

    # Validate the hierarchy before inserting the user so a bad/cross-office
    # reports_to value cannot leave a partially bootstrapped account behind.
    if reports_to:
        try:
            parent = await db.users.find_one({
                "_id": ObjectId(reports_to),
                "role": {"$in": ["leader", "admin"]},
                "deleted": {"$ne": True},
                "is_active": {"$ne": False},
            })
        except Exception:
            parent = None
        if not parent:
            raise HTTPException(status_code=400, detail="That coach was not found")
        if parent.get("office_id") != office_id:
            raise HTTPException(status_code=400, detail="The coach must be in the same office")

    new_doc = {
        "email": email,
        "password_hash": hash_password(password),
        "name": name,
        "role": role,
        "office_id": office_id,
        "email_verified": True,            # bypass OTP — admin vouches for the user
        "reports_to": reports_to,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by_admin_id": admin.get("id"),
    }
    result = await db.users.insert_one(new_doc)
    new_id = str(result.inserted_id)

    # ── Trainee-specific bootstrap ─────────────────────────────────────
    # Same record the Add Trainee screen (POST /new-hires) builds: a
    # `new_hires` row plus Day 1–8 Pending assessments with checklists from
    # this office's training manual (core/trainee_records.py).
    if role == "trainee":
        leader_name = "Unassigned"
        if reports_to:
            try:
                leader_user = await db.users.find_one({"_id": ObjectId(reports_to)})
                if leader_user:
                    leader_name = leader_user.get("name") or "Unassigned"
            except Exception:
                pass
        await create_training_record(
            db, name=name, office_id=office_id, trainee_user_id=new_id,
            leader_name=leader_name,
        )

    # Optional welcome email with embedded credentials
    if send_email_flag:
        try:
            send_admin_created_account_email(name=name, email=email, password=password, role=role)
        except Exception as e:
            logger.error(f"admin_create_user welcome email failed: {e}")

    return {
        "id": new_id,
        "email": email,
        "name": name,
        "role": role,
        "reports_to": reports_to,
        "office_id": office_id,
        "email_sent": bool(send_email_flag),
    }


@router.get("/admin/users")
async def get_all_users(request: Request, office: Optional[str] = None):
    await require_admin(request)
    user = await get_current_user(request)
    query: dict = {"deleted": {"$ne": True}}
    if user.get("is_super_admin") and office:
        query["office_id"] = office
    elif not user.get("is_super_admin") and user.get("office_id"):
        query["office_id"] = user["office_id"]
    users = await db.users.find(query, {"password_hash": 0}).to_list(1000)
    for u in users:
        u["id"] = str(u["_id"])
        del u["_id"]
    return users

@router.put("/admin/users/{user_id}/role")
async def update_user_role(user_id: str, req: PromoteRequest, request: Request):
    admin = await require_admin(request)
    if req.role not in ("admin", "leader", "trainee"):
        raise HTTPException(status_code=400, detail="Invalid role. Must be 'admin', 'leader' (Coach) or 'trainee' (BA)")
    if admin["id"] == user_id:
        raise HTTPException(status_code=400, detail="You cannot change your own role")
    # Scope guard — office admins can only touch users in their own office.
    target = await _guard_target_user(admin, user_id)
    was_trainee = target.get("role") == "trainee"
    change: dict = {"$set": {"role": req.role}}
    if req.role != "leader":
        change["$unset"] = {"coach_plus": ""}   # Coach+ belongs to a Coach only
    await db.users.update_one({"_id": ObjectId(user_id)}, change)
    # Demotion back to trainee: reverse the promotion close-out (reactivate
    # the hire record, un-complete only auto-completed assessments) and skip
    # every promotion side effect below. No email/push — a demotion is the
    # office's conversation to have, not the app's.
    if req.role == "trainee":
        if not was_trainee:
            try:
                await reopen_demoted_hire(target)
            except Exception as e:
                logger.error(f"demotion reopen failed for {user_id}: {e}")
        return {"message": f"Role updated to {role_label(req.role)}"}
    # A leader is no longer a trainee — retire their own 8-day record so
    # nothing keeps asking for their ungraded assessments.
    if was_trainee:
        try:
            await close_out_promoted_hire(target)
        except Exception as e:
            logger.error(f"promotion close-out failed for {user_id}: {e}")
        # close_out_promoted_hire completes any remaining assessments
        # directly (bypassing the normal grading endpoint), so it earns the
        # Stage 1 Graduate badge too — award it here rather than waiting for
        # the next backfill to pick it up.
        try:
            from core.achievements import award, award_stage1_milestones
            await award(user_id, "stage1_complete")
            hire_id = target.get("new_hire_id")
            if not hire_id:
                hire_doc = await db.new_hires.find_one({"trainee_user_id": user_id}, {"id": 1})
                hire_id = (hire_doc or {}).get("id")
            if hire_id:
                await award_stage1_milestones(hire_id, user_id)
        except Exception as e:
            logger.error(f"stage1_complete award error: {e}")
    # Achievement: everyone above the newly-promoted leader now "has a
    # leader on their team" — the Core Leader badge.
    try:
        from core.achievements import award_upline_core_leader
        await award_upline_core_leader(user_id)
    except Exception as e:
        logger.error(f"core_leader award error: {e}")
    # Send promotion email if promoted from trainee to leader
    if was_trainee and req.role == "leader" and target:
        send_promotion_email(target.get("name", ""), target.get("email", ""))
        try:
            await send_push_to_user(
                user_id,
                "🎉 You've advanced to Stage 3!",
                "Congratulations — you're now a Coach. Tap to see your new team features.",
                {"type": "promotion"},
            )
        except Exception as e:
            logger.error(f"promotion push error: {e}")

        # OwnerIQ — advance the promoted rep to Stage 3 (leader) to mirror CG1.
        # Fire-and-forget; gated by OWNERIQ_WRITES_ENABLED (no-op until enabled).
        try:
            import asyncio as _aio
            from owneriq_write import hook_promotion_to_leader
            _aio.create_task(hook_promotion_to_leader(user_id))
        except Exception as _e:
            logger.warning(f"OwnerIQ promotion hook skipped: {_e}")

    return {"message": f"User role updated to {role_label(req.role)}"}


@router.put("/admin/users/{user_id}/coach-plus")
async def set_coach_plus(user_id: str, request: Request):
    """Admin: make a Coach a Coach+ (whole-office Live Operations, Performance
    Hub, Field KPIs and ID badges), or take it back. Body: {enabled: bool}."""
    admin = await require_admin(request)
    target = await _guard_target_user(admin, user_id)
    body = await request.json()
    enabled = bool((body or {}).get("enabled"))
    if enabled and target.get("role") != "leader":
        raise HTTPException(status_code=400, detail="Only a Coach can be made Coach+")
    if enabled:
        await db.users.update_one({"_id": target["_id"]}, {"$set": {
            "coach_plus": True, "coach_plus_at": datetime.now(timezone.utc).isoformat(), "coach_plus_by": admin["id"]}})
    else:
        await db.users.update_one({"_id": target["_id"]}, {"$unset": {"coach_plus": "", "coach_plus_at": "", "coach_plus_by": ""}})
    return {"coach_plus": enabled, "message": f"{target.get('name') or 'They'} {'is now Coach+' if enabled else 'is back to Coach'}"}


@router.put("/admin/users/{user_id}/team-name")
async def admin_set_user_team_name(user_id: str, request: Request):
    """Admin-only override for a user's team name (the team they lead)."""
    admin = await require_admin(request)
    await _guard_target_user(admin, user_id)
    body = await request.json()
    raw = (body.get("team_name") or "").strip()
    if raw and len(raw) > 40:
        raise HTTPException(status_code=400, detail="Team name must be 40 characters or fewer")
    if raw:
        await db.users.update_one({"_id": ObjectId(user_id)}, {"$set": {"team_name": raw}})
    else:
        await db.users.update_one({"_id": ObjectId(user_id)}, {"$unset": {"team_name": ""}})
    # OwnerIQ — create/rename this leader's team. Gated by OWNERIQ_WRITES_ENABLED.
    if raw:
        try:
            import asyncio as _aio
            from owneriq_write import hook_team_name
            _aio.create_task(hook_team_name(user_id, raw))
        except Exception as _e:
            logger.warning(f"OwnerIQ team-name hook skipped: {_e}")
    return {"ok": True, "team_name": raw or None}


@router.delete("/admin/users/{user_id}")
async def delete_user(user_id: str, request: Request):
    admin = await require_admin(request)
    user = await _guard_target_user(admin, user_id)
    if user.get("role") == "leader":
        leader_name = user.get("name", "")
        await db.new_hires.update_many(
            {"leader": leader_name, "office_id": user.get("office_id"),
             "$or": [{"leader_user_id": None}, {"leader_user_id": {"$exists": False}}]},
            {"$set": {"leader": "Unassigned"}},
        )
        await db.new_hires.update_many(
            {"leader_user_id": user_id},
            {"$set": {"leader": "Unassigned", "leader_user_id": None}},
        )
        await db.users.update_many(
            {"reports_to": user_id, "office_id": user.get("office_id")},
            {"$unset": {"reports_to": ""}},
        )
    # Soft-delete: mark deleted but keep all data so historical reports stay accurate.
    # Assessments, badges, new_hire records are preserved for historical stats.
    #
    # `left_on` is the *last day they worked*, as a plain date. `deleted_at` is
    # when an admin got round to pressing the button, which is often days later
    # — good for auditing, useless for "was she here on Wednesday?". Anything
    # that plans day by day (Office Primetime) reads `left_on`: the person stays
    # on the plan up to and including that date, and drops off after it.
    now = datetime.now(timezone.utc)
    await db.users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {
            "deleted": True,
            "deleted_at": now.isoformat(),
            "left_on": now.astimezone(APP_TZ).date().isoformat(),
        }},
    )
    # OwnerIQ — a binned rep keeps their ghost record here but should be
    # deactivated on OwnerIQ. Fire-and-forget; gated by OWNERIQ_WRITES_ENABLED.
    try:
        import asyncio as _aio
        from owneriq_write import hook_termination
        _aio.create_task(hook_termination(user_id))
    except Exception as _e:
        logger.warning(f"OwnerIQ termination hook skipped: {_e}")
    # Deactivate any new_hire record tied to this user so they stop appearing
    # in live views (Unassigned tab, team counts, etc.).
    # Three ways a hire can link back to this user:
    #   1. trainee_user_id = user_id (admin-created users, new flow)
    #   2. id = user.new_hire_id (backlink set at creation)
    #   3. name match (legacy records where trainee_user_id was never set)
    hire_clauses: list = [{"trainee_user_id": user_id}]
    user_hire_id = user.get("new_hire_id")
    if user_hire_id:
        hire_clauses.append({"id": user_hire_id})
    user_name = user.get("name", "")
    if user_name:
        hire_clauses.append({"name": user_name})
    await db.new_hires.update_many(
        {"office_id": user.get("office_id"), "$or": hire_clauses},
        {"$set": {"active": False}},
    )
    return {"message": "User deleted"}

@router.get("/admin/leader-rankings")
async def get_leader_rankings(request: Request):
    await require_admin(request)
    user = await get_current_user(request)
    # 🔒 Filter leaders by office for non-super admins so one office's admin
    # can't see another office's leaders' ranking (the per-hire filter below was already
    # office-scoped, but the leader list itself leaked their names).
    leader_q: dict = {"role": "leader", "deleted": {"$ne": True}, "is_active": {"$ne": False}}
    if not user.get("is_super_admin") and user.get("office_id"):
        leader_q["office_id"] = user["office_id"]
    leaders = await db.users.find(leader_q, {"password_hash": 0}).to_list(100)
    rankings = []
    for leader in leaders:
        leader_name = leader.get("name", "")
        query = {"leader": leader_name, "active": True}
        if not user.get("is_super_admin") and user.get("office_id"):
            query["office_id"] = user["office_id"]
        hires = await db.new_hires.find(query).to_list(100)
        total = len(hires)
        if total == 0:
            continue
        hire_ids = [h["id"] for h in hires]
        assessments = await db.daily_assessments.find(
            {"new_hire_id": {"$in": hire_ids}, "completed": True}
        ).to_list(1000)
        scores = [a["overall_score"] for a in assessments if a.get("overall_score") is not None]
        avg = round(sum(scores) / len(scores), 2) if scores else 0
        statuses = {}
        for h in hires:
            s = h.get("current_status", "Pending")
            statuses[s] = statuses.get(s, 0) + 1
        rankings.append({
            "leader_id": str(leader["_id"]),
            "leader_name": leader_name,
            "email": leader.get("email", ""),
            "total_hires": total,
            "avg_score": avg,
            "completed_assessments": len(scores),
            "status_breakdown": statuses,
            "profile_image": leader.get("profile_image"),
        })
    rankings.sort(key=lambda x: x["avg_score"], reverse=True)
    return rankings

# ────────────────────────────────────────────────────────────────────────
# Manual trigger for the weekly bulletin push (so you can test the flow
# without waiting until Monday 9am UK time). Sends the same notification that
# the cron job would send, to every admin/super-admin with a push token.
# ────────────────────────────────────────────────────────────────────────
@router.post("/admin/weekly-bulletins/test-push")
async def trigger_weekly_bulletin_push(request: Request):
    admin = await require_admin(request)
    try:
        body = await request.json()
        only_me = bool(body.get("only_me", True))
    except Exception:
        only_me = True

    # Per-user send covers BOTH channels — the old token-filtered
    # send_push_to_token silently skipped web-push-only admins — and lands
    # an in-app inbox row for free.
    query: dict = {"deleted": {"$ne": True}, "is_active": {"$ne": False}}
    if only_me:
        try:
            query["_id"] = ObjectId(admin["id"])
        except Exception:
            query["_id"] = admin.get("id")
    else:
        query["$or"] = [{"role": "admin"}, {"is_super_admin": True}]

    sent = 0
    async for u in db.users.find(query, {"_id": 1}):
        await send_push_to_user(
            str(u["_id"]),
            title="📊 Weekly bulletins ready",
            body="Tap to share last week's Sign-ups + Team bulletins to WhatsApp.",
            data={"type": "weekly_bulletins", "url": "/weekly-share"},
        )
        sent += 1

    return {
        "message": "Weekly bulletin push fired",
        "sent": sent,
        "skipped_no_token": 0,
        "only_me": only_me,
    }


@router.post("/admin/backfill-missing-new-hires")
async def backfill_missing_new_hires(request: Request):
    """Repair tool: create the training record (new_hires row + Day 1–8
    assessments and checklists) for any trainee account that has none —
    e.g. a user whose role was changed to trainee after being created as a
    leader. Idempotent: fixed accounts gain a new_hire_id and stop matching."""
    await require_super_admin(request)
    users = await db.users.find(
        {"role": "trainee", "deleted": {"$ne": True},
         "$or": [{"new_hire_id": {"$exists": False}}, {"new_hire_id": None}, {"new_hire_id": ""}]},
        {"_id": 1, "name": 1, "office_id": 1, "created_at": 1},
    ).to_list(500)

    results = []
    for u in users:
        user_id = str(u["_id"])
        name = u.get("name", "Unknown")
        created_at = u.get("created_at") or datetime.now(timezone.utc).isoformat()
        try:
            start_date = datetime.fromisoformat(str(created_at).replace("Z", "+00:00")).strftime("%Y-%m-%d")
        except Exception:
            start_date = None
        hire = await create_training_record(
            db, name=name, office_id=u.get("office_id"), trainee_user_id=user_id,
            start_date=start_date,
        )
        results.append({"user_id": user_id, "name": name, "new_hire_id": hire["id"]})
        logger.info(f"backfill: created new_hire {hire['id']} for user {user_id} ({name})")

    return {"fixed": len(results), "users": results}


@router.post("/admin/patch-assessment-days")
async def patch_assessment_days(request: Request):
    """Add missing daily_assessment rows (up to day 8) for any new_hire that
    has fewer than 8. Idempotent — safe to run multiple times."""
    await require_super_admin(request)
    new_hires = await db.new_hires.find({}, {"_id": 0, "id": 1, "name": 1, "office_id": 1}).to_list(1000)
    patched = []
    for hire in new_hires:
        hire_id = hire["id"]
        office_id = hire.get("office_id")
        name = hire.get("name", "")
        existing = await db.daily_assessments.find(
            {"new_hire_id": hire_id}, {"day_number": 1}
        ).to_list(20)
        existing_days = {e["day_number"] for e in existing}
        missing = [d for d in range(1, 9) if d not in existing_days]
        if not missing:
            continue
        await create_assessment_skeleton(db, hire_id, name, office_id, days=missing)
        patched.append({"new_hire_id": hire_id, "name": name, "added_days": missing})
        logger.info(f"patch-assessment-days: added days {missing} for new_hire {hire_id} ({name})")

    return {"patched": len(patched), "records": patched}


# ==================== BADGE ROUTES ====================
