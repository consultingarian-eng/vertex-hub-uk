"""Multi-stage Training Modules API.

Stages:
  - Stage 0 (Orientation, Days 1-2)  → existing `training_manual` (assessment style)
  - Stage 1 (Field, Days 3-8)         → existing `training_manual` (assessment style)
  - Stage 2 (Independence, Weeks 2-3) → modules (this file) — trainees
  - Stage 3 (Leader)                  → modules (this file) — leaders only
  - Stage 4 (Advanced)                → modules (this file) — leaders only (future)

Collections used:
  - training_modules        rich module content (one per stage/category/topic)
  - module_progress         per-(user, module) scores on 4 dimensions
  - daily_assessments       (existing) used to compute Stage 1 completion gate

Stage-2 unlock rule: trainee must have SUBMITTED a daily_assessment for every
day 1-8 (regardless of grade). That's the "all submitted" gate the user asked
for. Stage-3 unlock rule: any user with role in {leader, admin}.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel, Field
from bson import ObjectId

from database import db
from core.app_time import APP_TZ
from core.brand import BRITISH_ENGLISH, SELF_EMPLOYED_TERMS
from auth import get_current_user, get_subtree_ids
from core.office_helpers import resolve_office_id
from core.achievements import (
    award_module_stage_completion,
    award_quiz_badges,
    award_stage1_milestones,
)
from core.module_seed import all_seed_modules, ASSESSMENT_DIMENSIONS, ASSESSMENT_BANDS, LADDER_RUNGS, LADDER_COMPLETED_AT
from core.cod_stages import cod_stage_rank

logger = logging.getLogger(__name__)
router = APIRouter()


# ──────────────────────────── helpers ──────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _strip_id(d: dict) -> dict:
    if not d:
        return d
    d.pop("_id", None)
    return d


async def _team_has_junior_leader(user: dict) -> bool:
    """True if `user` has at least one OTHER leader in their reports-to subtree.
    Used to gate Stage 3 access (must be coaching at least one junior leader)."""
    uid = str(user.get("id") or user.get("_id") or "")
    if not uid:
        return False
    # Walk subtree (includes self), then look for leaders other than self
    sub = await get_subtree_ids(uid)
    other_ids = [s for s in sub if s != uid]
    if not other_ids:
        return False
    try:
        obj_ids = [ObjectId(s) for s in other_ids]
    except Exception:
        return False
    cnt = await db.users.count_documents(
        {"_id": {"$in": obj_ids}, "role": {"$in": ["leader", "admin"]}}
    )
    return cnt > 0


async def _is_stage_unlocked(user: dict, stage: int) -> bool:
    """Returns True if `user` is allowed to view+score modules at this stage.

    Rules (per latest product spec):
      • Stage 1 — everyone: it's the Foundation stage trainees are on from
        day one, and leaders/admins coach + sign it off (COD 1).
      • Stage 2 — leaders/admins always have access (so they can coach &
        grade their trainees). Trainees unlock ONLY when every Day 1-8
        daily_assessment has been **passed off** (not just submitted) by
        their leader. This mirrors the Stage 3 lock UX: visible-but-locked
        until the leader explicitly signs off on Orientation + Stage 1.
      • Stage 3 — leaders unlock IFF they have at least one junior leader in
        their subtree; admins always.
      • Stage 4 — admins only (hidden from all leaders for now).
    """
    role = (user.get("role") or "").lower()
    if stage == 1:
        return role in ("trainee", "leader", "admin")
    if stage == 2:
        if role in ("leader", "admin"):
            return True
        hire_id = user.get("new_hire_id")
        if not hire_id:
            return False
        # Stage 2 unlocks once the trainee has COMPLETED every Day 1-8 daily
        # assessment (formal pass-off is no longer a gating signal — see PR
        # 2026-05 product spec).
        completed_days = await db.daily_assessments.distinct(
            "day_number", {"new_hire_id": hire_id, "completed": True}
        )
        return all(d in (completed_days or []) for d in range(1, 9))
    if stage == 3:
        if role == "admin":
            return True
        if role == "leader":
            return await _team_has_junior_leader(user)
        return False
    if stage == 4:
        return role == "admin"
    if stage == 5:
        # Stage SL (Sector/Site Leader) — open to every leader (the people
        # who run sectors) and to admins, so they can browse and grade.
        return role in ("leader", "admin")
    return False


async def _ensure_seeded(office_id: Optional[str] = None) -> None:
    """Seed module content for this office. Idempotent, and additive: an
    office seeded before a new stage or topic existed picks the additions up
    here — anything whose (stage, topic) is absent gets inserted. Existing
    modules (possibly edited in the manual editor) are never touched.

    Also self-healing: the old read-then-insert pattern could race when two
    requests hit a freshly-added stage at once (this is exactly how Stage 1's
    16 modules got doubled in Sep 2026), so duplicate (stage, topic) copies
    are merged here — progress rows re-point to the surviving copy — and
    inserts go through an atomic $setOnInsert upsert instead."""
    scope = office_id  # None = global template for offices not yet set up
    by_key: dict = {}
    async for m in db.training_modules.find(
        {"office_id": scope},
        {"id": 1, "stage": 1, "topic": 1, "created_at": 1, "cod_vetted_at": 1, "retired": 1},
    ):
        by_key.setdefault((m.get("stage"), m.get("topic")), []).append(m)

    # ── Merge duplicate copies of the same capability ─────────────────────
    for docs in by_key.values():
        if len(docs) <= 1:
            continue
        scored = []
        for d in docs:
            cnt = await db.module_progress.count_documents({"module_id": d.get("id")})
            scored.append((d, cnt))
        # Keeper: vetted beats unvetted, then most progress, then live beats
        # retired, then the oldest copy (stable across repeated heals).
        scored.sort(key=lambda t: (
            0 if t[0].get("cod_vetted_at") else 1,
            -t[1],
            1 if t[0].get("retired") else 0,
            t[0].get("created_at") or "",
        ))
        keeper = scored[0][0]
        loser_ids = [d.get("id") for d, _ in scored[1:] if d.get("id")]
        if not loser_ids:
            continue
        # Re-point each progress row unless the person already has one on the
        # keeper (then the duplicate row is dropped, not doubled).
        async for p in db.module_progress.find({"module_id": {"$in": loser_ids}}):
            tgt = p.get("target_user_id") or p.get("user_id")
            existing = await db.module_progress.find_one({
                "module_id": keeper.get("id"),
                "$or": [
                    {"target_user_id": tgt},
                    {"target_user_id": {"$exists": False}, "user_id": tgt},
                ],
            })
            if existing:
                await db.module_progress.delete_one({"_id": p["_id"]})
            else:
                await db.module_progress.update_one({"_id": p["_id"]}, {"$set": {"module_id": keeper.get("id")}})
        await db.training_modules.delete_many({"office_id": scope, "id": {"$in": loser_ids}})

    # ── Additive insert — atomic per (office, stage, topic) ───────────────
    for m in all_seed_modules():
        if (m.get("stage"), m.get("topic")) in by_key:
            continue
        await db.training_modules.update_one(
            {"office_id": scope, "stage": m.get("stage"), "topic": m.get("topic")},
            {"$setOnInsert": {**m, "id": str(uuid.uuid4()), "office_id": scope, "created_at": _now_iso()}},
            upsert=True,
        )


def _module_in_scope(user: dict, module: dict) -> bool:
    if user.get("is_super_admin"):
        return True
    office_id = user.get("office_id")
    return bool(office_id) and module.get("office_id") in (office_id, None)


async def _target_in_scope(user: dict, target_user_id: str) -> bool:
    try:
        target = await db.users.find_one({
            "_id": ObjectId(target_user_id),
            "deleted": {"$ne": True},
            "is_active": {"$ne": False},
        })
    except Exception:
        return False
    if not target:
        return False
    if user.get("is_super_admin"):
        return True
    return bool(user.get("office_id")) and target.get("office_id") == user.get("office_id")


# ──────────────────────────── public endpoints ─────────────────────────────


@router.get("/modules/scale")
async def get_scale():
    """Returns the assessment scale — used by the UI. `ladder` is the COD
    2026 proof ladder (the grader); bands/dimensions are the legacy 1-10
    scheme kept for old clients."""
    return {"bands": ASSESSMENT_BANDS, "dimensions": ASSESSMENT_DIMENSIONS,
            "ladder": LADDER_RUNGS, "ladder_completed_at": LADDER_COMPLETED_AT,
            "ladder_max_by_stage": {1: 3, 2: 3, 3: 4, 4: 5, 5: 5}}


@router.get("/modules")
async def list_modules(
    request: Request,
    stage: int = Query(..., ge=1, le=5),
    office: Optional[str] = None,
):
    """List all modules in a stage, scoped to the authenticated user's office."""
    user = await get_current_user(request)
    office_id = await resolve_office_id(request, user, office)
    # Lazy-seed on first call so a fresh deploy gets content automatically
    await _ensure_seeded(office_id)
    # Fall back to global modules if office has none
    cursor = db.training_modules.find({"stage": stage, "office_id": office_id, "retired": {"$ne": True}})
    rows = [_strip_id(r) async for r in cursor]
    if not rows:
        cursor = db.training_modules.find({"stage": stage, "office_id": None, "retired": {"$ne": True}})
        rows = [_strip_id(r) async for r in cursor]
    rows.sort(key=lambda r: r.get("sequence", 0))
    unlocked = await _is_stage_unlocked(user, stage)
    return {
        "stage": stage,
        "unlocked": unlocked,
        "modules": rows,
    }


@router.get("/modules/{module_id}")
async def get_module(module_id: str, request: Request):
    """Fetch a single module's content. READ access is more permissive than
    grading access — a leader without a junior-leader team should still see
    Stage 3 content for their OWN personal growth. The write gate
    (`_is_stage_unlocked`) is enforced separately in `upsert_progress`.

    Read rules:
      • Admin — always.
      • Leader — Stage 2 and Stage 3 always readable; Stage 4 requires unlock.
      • Trainee — Stage 2 readable once it's unlocked by their day-1-8 gate;
        Stage 3/4 never readable.
    """
    user = await get_current_user(request)
    m = await db.training_modules.find_one({"id": module_id})
    if not m:
        raise HTTPException(status_code=404, detail="Module not found")
    if not _module_in_scope(user, m):
        raise HTTPException(status_code=403, detail="Module belongs to a different office")
    stage = int(m.get("stage") or 0)
    role = (user.get("role") or "").lower()
    if role == "admin":
        pass  # always allowed
    elif role == "leader":
        # Leaders can always READ Stage 2 (to coach trainees) and Stage 3
        # (for personal growth). Stage 4 remains admin-only.
        if stage >= 4:
            raise HTTPException(status_code=403, detail="Stage not unlocked")
    else:
        # Trainee — still gated behind Stage 2 unlock logic.
        if not await _is_stage_unlocked(user, stage):
            raise HTTPException(status_code=403, detail="Stage not unlocked")
    return _strip_id(m)


# ──────────────────────────── progress ─────────────────────────────────────


class ScoreUpdate(BaseModel):
    knowledge: Optional[int] = Field(None, ge=1, le=10)
    skill: Optional[int] = Field(None, ge=1, le=10)
    consistency: Optional[int] = Field(None, ge=1, le=10)
    independence: Optional[int] = Field(None, ge=1, le=10)
    # COD 2026 proof ladder: 0 = not started, 1 Know … 5 Systemize. The
    # legacy 1-10 dimensions above remain accepted so older app builds keep
    # working; new builds send `ladder`.
    ladder: Optional[int] = Field(None, ge=0, le=5)
    # Per-rung dates — the sheet's date boxes: when each rung was actually
    # proven. Keys: know/do/deliver/teach/systemize, values YYYY-MM-DD.
    # Auto-stamped with today when a rung is first ticked; editable to
    # backfill from paper or correct a date.
    ladder_dates: Optional[dict] = None
    # The back page's tick boxes: indexes of what_good_looks_like bullets
    # that have been hit and measured for this person. Full-list replace.
    wgll_checked: Optional[list] = None
    leader_notes: Optional[str] = None


def _normalise_progress_row(r: dict) -> dict:
    """Backfill `target_user_id`/`assessor_id` on legacy rows so older self-
    assessed records keep working under the new leader-grades-trainee schema."""
    if not r:
        return r
    r = _strip_id(r)
    if not r.get("target_user_id"):
        r["target_user_id"] = r.get("user_id")
    return r


_RUNG_KEYS = ["know", "do", "deliver", "teach", "systemize"]  # index = rung-1


def _max_rung_for_stage(stage: int) -> int:
    """The ladder grows with the stage: Stages 1-2 top out at Deliver,
    Stage 3 adds Teach, Stage 4 and SL add Systemize."""
    if stage <= 2:
        return 3
    if stage == 3:
        return 4
    return 5


def _today_iso() -> str:
    return datetime.now(APP_TZ).date().isoformat()


def _apply_ladder_dates(existing_dates: dict, ladder: int, edits: dict | None,
                        max_editable_rung: int, today: str) -> dict:
    """The sheet's date boxes. Returns the new ladder_dates dict:
      • every achieved rung (≤ ladder) keeps its date, or gets `today`
        stamped if it never had one;
      • rungs above the current ladder lose their dates (unticked);
      • `edits` overrides dates for achieved rungs the caller may write
        (rung ≤ max_editable_rung), validated as YYYY-MM-DD.
    """
    from datetime import date as _date
    out = dict(existing_dates or {})
    for i, key in enumerate(_RUNG_KEYS):
        rung = i + 1
        if rung > ladder:
            out.pop(key, None)
            continue
        if edits and key in edits and rung <= max_editable_rung:
            v = str(edits[key] or "").strip()
            try:
                out[key] = _date.fromisoformat(v).isoformat()
            except ValueError:
                pass  # invalid date — keep whatever we had
        if not out.get(key):
            out[key] = today
    return out


def _compute_completed(merged: dict) -> bool:
    """COD 2026: a capability is met once the proof ladder reaches Deliver
    (coach-confirmed). Legacy paths still count: an explicit pass-off, or
    the old 4-dimension rule (all ≥ 7) from pre-ladder grading."""
    if (merged.get("ladder") or 0) >= LADDER_COMPLETED_AT:
        return True
    if merged.get("passed_off"):
        return True
    if not all(merged.get(k) is not None for k in ASSESSMENT_DIMENSIONS):
        return False
    return all((merged.get(k) or 0) >= 7 for k in ASSESSMENT_DIMENSIONS)


@router.get("/module-progress/me")
async def my_progress(
    request: Request,
    stage: int = Query(..., ge=1, le=5),
):
    """All progress rows for the current user at a given stage. For Stage 2
    this returns rows where the trainee is the TARGET (graded BY a leader).
    For Stage 3/4 (self-assessment) the user IS the target."""
    user = await get_current_user(request)
    user_id = str(user.get("id") or user.get("_id") or "")
    rows = []
    # Match either: target_user_id == me  OR  legacy rows with user_id == me
    cursor = db.module_progress.find({
        "stage": stage,
        "$or": [
            {"target_user_id": user_id},
            {"target_user_id": {"$exists": False}, "user_id": user_id},
        ],
    })
    async for r in cursor:
        rows.append(_normalise_progress_row(r))
    return {"stage": stage, "progress": rows}


async def _user_can_grade_target(user: dict, target_user_id: str, stage: int) -> bool:
    """Check whether `user` can grade `target_user_id` AT ALL at this stage.

    Used as a coarse 403-or-not gate. Fine-grained per-dimension control is
    in `_dims_user_can_grade`.
    """
    dims = await _dims_user_can_grade(user, target_user_id, stage)
    return len(dims) > 0


_ALL_DIMS = {"knowledge", "skill", "consistency", "independence"}
_SELF_DIMS = {"knowledge", "skill"}  # leaders self-rating Stage 3


async def _dims_user_can_grade(user: dict, target_user_id: str, stage: int) -> set:
    """Return the set of {knowledge, skill, consistency, independence}
    dimensions `user` is allowed to write for `target_user_id` at `stage`.

    Empty set ⇒ caller should 403.

    Rules
    ─────
      • Admin           → all 4 dimensions, anyone, any stage.
      • Stage 1/2 (same rules — the coach signs the Foundation sheet too):
          – Leader rating SELF (from leadership hub review) → all 4.
          – Leader rating a trainee in their subtree       → all 4.
          – Anything else                                   → none.
      • Stage 3:
          – Leader rating SELF                       → {knowledge, skill}
            (self can't certify their own consistency / independence).
          – Leader rating a sub-leader in subtree    → all 4.
          – Anything else                            → none.
      • Stage 4: admin only (already covered above).
    """
    role = (user.get("role") or "").lower()
    uid = str(user.get("id") or user.get("_id") or "")
    if role == "admin":
        return set(_ALL_DIMS) if await _target_in_scope(user, target_user_id) else set()
    if not await _target_in_scope(user, target_user_id):
        return set()
    if stage in (1, 2):
        if role == "leader":
            if target_user_id == uid:
                # Leaders reviewing their own Stage 2 history from the leadership
                # hub self-rate all 4 dimensions (UI says "Score yourself on 4 dims").
                return set(_ALL_DIMS)
            sub = await get_subtree_ids(uid)
            if target_user_id in sub and target_user_id != uid:
                return set(_ALL_DIMS)
        return set()
    if stage == 3:
        if role == "leader":
            if target_user_id == uid:
                # Self-rate Knowledge + Skill only — Consistency &
                # Independence must come from a higher-level leader/admin.
                return set(_SELF_DIMS)
            sub = await get_subtree_ids(uid)
            if target_user_id in sub:
                # Confirm target is actually a leader (Stage 3 is leader-only).
                try:
                    target = await db.users.find_one({"_id": ObjectId(target_user_id)})
                except Exception:
                    target = None
                if target and (target.get("role") or "").lower() == "leader":
                    return set(_ALL_DIMS)
        return set()
    if stage == 4:
        return set()  # admin already short-circuited
    return set()


@router.put("/module-progress/{module_id}")
async def upsert_progress(
    module_id: str,
    payload: ScoreUpdate,
    request: Request,
    target_user_id: Optional[str] = Query(None, description="If set, a coach/admin grades this user instead of self"),
):
    """Upsert progress for a module. Without ?target_user_id this is a self-
    assessment (Stage 3 leader). With ?target_user_id a leader can grade a
    trainee (Stage 2) or admin can grade a leader (Stage 3/4).

    Permission is now per-DIMENSION via `_dims_user_can_grade`. Leaders
    self-rating Stage 3 may write only Knowledge & Skill — Consistency &
    Independence are silently dropped (the frontend disables those sliders;
    this is a defence-in-depth filter).
    """
    user = await get_current_user(request)
    m = await db.training_modules.find_one({"id": module_id})
    if not m:
        raise HTTPException(status_code=404, detail="Module not found")
    if not _module_in_scope(user, m):
        raise HTTPException(status_code=403, detail="Module belongs to a different office")
    stage = int(m.get("stage") or 0)
    role = (user.get("role") or "").lower()
    assessor_id = str(user.get("id") or user.get("_id") or "")

    # Resolve target. Trainees can never grade.
    if role == "trainee":
        raise HTTPException(status_code=403, detail="New BAs cannot grade")
    if not target_user_id:
        target_user_id = assessor_id

    allowed_dims = await _dims_user_can_grade(user, target_user_id, stage)
    if not allowed_dims:
        raise HTTPException(status_code=403, detail="Not allowed to grade this user")

    existing = await db.module_progress.find_one({
        "$or": [
            {"target_user_id": target_user_id, "module_id": module_id},
            # Legacy rows pre-target_user_id migration
            {"user_id": target_user_id, "module_id": module_id, "target_user_id": {"$exists": False}},
        ],
    })

    raw_update = {k: v for k, v in payload.model_dump(exclude_none=True).items()}
    # Filter score dimensions the caller is NOT allowed to write
    update: dict = {}
    for k, v in raw_update.items():
        if k in _ALL_DIMS and k not in allowed_dims:
            continue  # silently drop locked dims
        update[k] = v
    # Proof ladder: self-assessment may claim Know/Do (≤ 2); Deliver, Teach
    # and Systemize are coach sign-offs — upline leader or admin only. This
    # mirrors the printed sheet: the BA works the material, the coach signs
    # the proof.
    stage_cap = _max_rung_for_stage(stage)
    max_ladder = stage_cap if (target_user_id != assessor_id or role == "admin") else min(2, stage_cap)
    if payload.ladder is not None:
        if payload.ladder > max_ladder:
            update.pop("ladder", None)  # silently drop, like locked dims
        else:
            update["ladder"] = payload.ladder
    # Date boxes: recompute whenever the ladder moves or dates are edited.
    update.pop("ladder_dates", None)
    if "ladder" in update or payload.ladder_dates is not None:
        eff_ladder = update.get("ladder")
        if eff_ladder is None:
            eff_ladder = int((existing or {}).get("ladder") or 0)
        update["ladder_dates"] = _apply_ladder_dates(
            (existing or {}).get("ladder_dates") or {},
            eff_ladder,
            payload.ladder_dates,
            max_ladder,
            _today_iso(),
        )
    if payload.wgll_checked is not None:
        n_bullets = len(m.get("what_good_looks_like") or [])
        update["wgll_checked"] = sorted({int(i) for i in payload.wgll_checked
                                         if isinstance(i, (int, float)) and 0 <= int(i) < n_bullets})
    if payload.leader_notes is not None:
        update["leader_notes"] = payload.leader_notes
    update["last_assessed_at"] = _now_iso()
    update["last_assessed_by_id"] = assessor_id
    update["assessor_id"] = assessor_id
    update["target_user_id"] = target_user_id  # Backfill if missing

    # A coach signing (or declining) a rung resolves the pending check.
    if "ladder" in update and target_user_id != assessor_id:
        update["ready_for_check"] = False
    merged = {**(existing or {}), **update}
    update["completed"] = _compute_completed(merged)

    if existing:
        await db.module_progress.update_one({"_id": existing["_id"]}, {"$set": update})
        out = {**existing, **update}
    else:
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": target_user_id,  # legacy alias kept for back-compat
            "target_user_id": target_user_id,
            "module_id": module_id,
            "stage": stage,
            **update,
        }
        await db.module_progress.insert_one(doc)
        out = doc
    if update["completed"]:
        try:
            await award_module_stage_completion(target_user_id, stage)
        except Exception as exc:
            logger.warning("module stage achievement award failed for %s: %s", target_user_id, exc)
        await _sales_path_recompute(target_user_id, stage)
    return _normalise_progress_row(out)


# ─────────────────────────── module quizzes ────────────────────────────────
# "Check your understanding" — 3 multiple-choice questions per module,
# generated once from the module's own trainee_content (Gemini, same key as
# the agenda scan) and cached per content-hash, so editing a module's content
# regenerates its quiz. Correct answers never leave the server — grading
# happens here and the result lands on the module_progress row. This is what
# makes Stage 2/3 learning progressive instead of checkbox-marking.


async def _sales_path_recompute(target_user_id: str, stage: int) -> None:
    """Stage 1–2 Commercial Craft at Deliver is a sales-path skill anchor —
    a signing here can complete Competency/Proficiency. No-op while the
    sales-path flag is off for this office."""
    if stage not in (1, 2):
        return
    try:
        from core.sales_path import recompute_sales_path
        await recompute_sales_path(target_user_id)
    except Exception as exc:
        logger.warning("sales-path recompute failed for %s: %s", target_user_id, exc)


async def _check_module_read(user: dict, m: dict) -> None:
    """Same read gate as get_module — raises 403 when not allowed."""
    if not _module_in_scope(user, m):
        raise HTTPException(status_code=403, detail="Module belongs to a different office")
    stage = int(m.get("stage") or 0)
    role = (user.get("role") or "").lower()
    if role == "admin":
        return
    if role == "leader":
        if stage == 4:
            raise HTTPException(status_code=403, detail="Stage not unlocked")
        if stage == 5 and not await _is_stage_unlocked(user, 5):
            raise HTTPException(status_code=403, detail="Stage not unlocked")
        return
    if not await _is_stage_unlocked(user, stage):
        raise HTTPException(status_code=403, detail="Stage not unlocked")


async def _get_or_create_quiz(m: dict, user: Optional[dict] = None) -> Optional[dict]:
    """The module's cached quiz, generating it on a cache miss. `user` is the
    person whose request caused the generation: they are charged one unit of
    the AI quota. A failed generation isn't retried for an hour."""
    import os
    import hashlib
    from core.rate_limit import generation_allowed, generation_started, generation_succeeded, take_ai_quota

    content = (m.get("trainee_content") or "").strip()
    good = m.get("what_good_looks_like") or []
    extra = "\n".join(str(x) for x in good) if isinstance(good, list) else str(good)
    if len(content) < 60:
        return None
    h = hashlib.sha1((content + "\n" + extra).encode("utf-8")).hexdigest()[:16]
    existing = await db.module_quizzes.find_one({"module_id": m["id"], "content_hash": h})
    if existing:
        return _strip_id(existing)

    gen_key = f"module-quiz:{m['id']}:{h}"
    if not generation_allowed(gen_key):
        return None
    from core.llm_keys import anthropic_api_key
    api_key = anthropic_api_key()
    if not api_key:
        return None
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
    except Exception:
        return None
    if user is not None:
        take_ai_quota(user)
    generation_started(gen_key)
    chat = LlmChat(
        api_key=api_key,
        session_id=f"module-quiz-{uuid.uuid4().hex[:10]}",
        system_message="You write short coaching quizzes. Return VALID JSON only — no prose, no code fences. " + BRITISH_ENGLISH + " " + SELF_EMPLOYED_TERMS,
    ).with_model("anthropic")

    prompt = (
        "Create exactly 3 multiple-choice questions testing understanding of this "
        "development module. Rules:\n"
        "- Answerable purely from the text below.\n"
        "- 4 answer choices each, exactly one correct, plausible distractors.\n"
        "- Practical (what would you DO), not trivia about wording.\n"
        "- Company vocabulary: say 'coach' for the person developing you (NEVER "
        "'manager', 'supervisor' or 'boss'), 'BA' for Brand Ambassadors (never 'rep', "
        "'staff' or 'employee'), 'sign-up' for a sale, 'supporter' for a donor, "
        "'sector' for a working area.\n"
        'Return JSON: {"questions":[{"question":"...","choices":["a","b","c","d"],"answer":0}]}\n\n'
        f"MODULE: {m.get('topic')}\n\nCONTENT:\n{content[:6000]}\n\n"
        f"WHAT GOOD LOOKS LIKE:\n{extra[:2000]}"
    )
    try:
        import asyncio
        resp = await asyncio.wait_for(chat.send_message(UserMessage(text=prompt)), timeout=45)
    except Exception:
        return None
    text = resp if isinstance(resp, str) else str(resp)
    cleaned = text.strip()
    import re as _re
    if cleaned.startswith("```"):
        cleaned = _re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = _re.sub(r"\s*```\s*$", "", cleaned)
    if not cleaned.startswith("{"):
        mt = _re.search(r"\{.*\}", cleaned, flags=_re.S)
        if mt:
            cleaned = mt.group(0)
    try:
        import json as _json
        parsed = _json.loads(cleaned)
    except Exception:
        return None

    qs = []
    for q in (parsed.get("questions") or [])[:5]:
        try:
            question = str(q.get("question") or "").strip()
            choices = [str(c).strip() for c in (q.get("choices") or [])][:4]
            answer = int(q.get("answer"))
        except Exception:
            continue
        if question and len(choices) == 4 and 0 <= answer <= 3 and all(choices):
            qs.append({"id": str(uuid.uuid4()), "question": question, "choices": choices, "answer": answer})
    if len(qs) < 3:
        return None
    doc = {
        "id": str(uuid.uuid4()),
        "module_id": m["id"],
        "content_hash": h,
        "questions": qs[:3],
        "created_at": _now_iso(),
    }
    generation_succeeded(gen_key)
    await db.module_quizzes.insert_one(doc.copy())
    doc.pop("_id", None)
    return doc


@router.get("/modules/{module_id}/quiz")
async def get_module_quiz(module_id: str, request: Request):
    """Quiz questions for a module — WITHOUT the correct answers."""
    user = await get_current_user(request)
    m = await db.training_modules.find_one({"id": module_id})
    if not m:
        raise HTTPException(status_code=404, detail="Module not found")
    if not _module_in_scope(user, m):
        raise HTTPException(status_code=403, detail="Module belongs to a different office")
    await _check_module_read(user, m)
    quiz = await _get_or_create_quiz(m, user)
    if not quiz:
        raise HTTPException(status_code=404, detail="No quiz available for this module yet")
    return {
        "quiz_id": quiz["id"],
        "questions": [{"id": q["id"], "question": q["question"], "choices": q["choices"]} for q in quiz["questions"]],
    }


class QuizSubmit(BaseModel):
    quiz_id: str
    answers: dict  # question_id -> chosen choice index


@router.post("/modules/{module_id}/quiz/submit")
async def submit_module_quiz(module_id: str, body: QuizSubmit, request: Request):
    """Grade a quiz attempt server-side and record it on the user's own
    module_progress row (quiz fields only — leader-graded dimensions and
    `completed` are untouched). Pass = at least 2 of 3."""
    user = await get_current_user(request)
    m = await db.training_modules.find_one({"id": module_id})
    if not m:
        raise HTTPException(status_code=404, detail="Module not found")
    await _check_module_read(user, m)
    quiz = await db.module_quizzes.find_one({"id": body.quiz_id, "module_id": module_id})
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz has been refreshed — reload and try again")

    score = 0
    results = []
    for q in quiz.get("questions") or []:
        try:
            chosen = int((body.answers or {}).get(q["id"], -1))
        except Exception:
            chosen = -1
        ok = chosen == q.get("answer")
        if ok:
            score += 1
        results.append({"id": q["id"], "correct": q.get("answer"), "chosen": chosen, "ok": ok})
    total = len(results)
    passed = total > 0 and score >= max(1, total - 1)

    uid = str(user.get("id") or user.get("_id") or "")
    now = _now_iso()
    existing = await db.module_progress.find_one({
        "$or": [
            {"target_user_id": uid, "module_id": module_id},
            {"user_id": uid, "module_id": module_id, "target_user_id": {"$exists": False}},
        ],
    })
    upd: dict = {"quiz_score": score, "quiz_total": total, "quiz_last_at": now}
    if passed:
        upd["quiz_passed"] = True
        upd["quiz_passed_at"] = now
    if existing:
        await db.module_progress.update_one({"_id": existing["_id"]}, {"$set": upd})
        if passed:
            # Passing the questions IS the Know check — tick rung 1, dated.
            # Guarded update so a concurrently coach-signed higher ladder is
            # never clobbered back down.
            await db.module_progress.update_one(
                {"_id": existing["_id"],
                 "$or": [{"ladder": {"$exists": False}}, {"ladder": None}, {"ladder": {"$lt": 1}}]},
                {"$set": {"ladder": 1,
                          "ladder_dates": _apply_ladder_dates(
                              (existing or {}).get("ladder_dates") or {}, 1, None, 5, _today_iso())}},
            )
    else:
        if passed:
            upd["ladder"] = 1
            upd["ladder_dates"] = _apply_ladder_dates({}, 1, None, 5, _today_iso())
        await db.module_progress.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": uid,
            "target_user_id": uid,
            "module_id": module_id,
            "stage": int(m.get("stage") or 0),
            **upd,
        })
    try:
        await award_quiz_badges(uid, score, total, passed, int(m.get("stage") or 0))
    except Exception as exc:
        logger.warning("module quiz achievement award failed for %s: %s", uid, exc)
    return {"score": score, "total": total, "passed": passed, "results": results}


# ─────────────────────── Leader-grades-trainee endpoints ───────────────────


@router.get("/leader/trainees")
async def list_my_trainees(request: Request):
    """List people the current user can grade.

      Leader → trainees in their subtree (role='trainee').
      Admin  → all trainees AND leaders within the offices they can see.

    The `role` field is returned on every row so the UI can group + badge."""
    user = await get_current_user(request)
    role = (user.get("role") or "").lower()
    if role not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach/admin only")
    uid = str(user.get("id") or user.get("_id") or "")
    if role == "admin":
        # Admin sees all trainees AND leaders in their accessible offices
        query: dict = {"role": {"$in": ["trainee", "leader"]}, "is_active": {"$ne": False}}
        # Self should never appear in own list (admin can't grade themselves
        # via this UI; the self-assess flow handles that)
        try:
            query["_id"] = {"$ne": ObjectId(uid)}
        except Exception:
            pass
        if not user.get("is_super_admin"):
            if not user.get("office_id"):
                raise HTTPException(status_code=403, detail="Your account is not assigned to an office")
            query["office_id"] = user["office_id"]
        users = await db.users.find(query, {
            "_id": 1, "name": 1, "email": 1, "role": 1,
            "new_hire_id": 1, "office_id": 1,
        }).to_list(1000)
    else:
        # Leader sees both trainees AND sub-leaders in their subtree (so they
        # can drill into a sub-leader and grade their Stage 3 modules).
        sub = await get_subtree_ids(uid)
        try:
            obj_ids = [ObjectId(s) for s in sub if s != uid]
        except Exception:
            obj_ids = []
        users = await db.users.find(
            {"_id": {"$in": obj_ids}, "role": {"$in": ["trainee", "leader"]}, "is_active": {"$ne": False}},
            {"_id": 1, "name": 1, "email": 1, "role": 1, "new_hire_id": 1, "office_id": 1},
        ).to_list(500)
    out = []
    for u in users:
        out.append({
            "id": str(u["_id"]),
            "name": u.get("name", ""),
            "email": u.get("email", ""),
            "role": (u.get("role") or "trainee").lower(),
            "new_hire_id": u.get("new_hire_id"),
            "office_id": u.get("office_id"),
        })
    out.sort(key=lambda x: (x["role"], x["name"].lower()))
    return {"trainees": out}


@router.get("/leader/trainees/{trainee_user_id}/module-progress")
async def trainee_module_progress(trainee_user_id: str, request: Request, stage: int = Query(2, ge=1, le=5)):
    """Get the full module-progress list for a single trainee. Caller must be
    the trainee's leader (subtree) or an admin."""
    user = await get_current_user(request)
    if not await _user_can_grade_target(user, trainee_user_id, stage):
        raise HTTPException(status_code=403, detail="Not allowed to view this BA")
    rows = []
    cursor = db.module_progress.find({
        "stage": stage,
        "$or": [
            {"target_user_id": trainee_user_id},
            {"target_user_id": {"$exists": False}, "user_id": trainee_user_id},
        ],
    })
    async for r in cursor:
        rows.append(_normalise_progress_row(r))
    return {"stage": stage, "trainee_user_id": trainee_user_id, "progress": rows}


# ───────────────────────────── Pass-off ────────────────────────────────────


class PassOffBody(BaseModel):
    passed_off: bool = True
    note: Optional[str] = None


@router.post("/module-progress/{module_id}/pass-off")
async def pass_off_module(
    module_id: str,
    body: PassOffBody,
    request: Request,
    target_user_id: str = Query(..., description="Whose progress to pass off"),
):
    """Mark a module as 'passed off' for a target user without changing scores.
    Allowed for ADMIN always; allowed for a LEADER iff there's an upper leader
    above the original assessor (i.e. you can pass off your direct report's
    leader's grading, but not your own grading)."""
    user = await get_current_user(request)
    role = (user.get("role") or "").lower()
    m = await db.training_modules.find_one({"id": module_id})
    if not m:
        raise HTTPException(status_code=404, detail="Module not found")
    if not _module_in_scope(user, m):
        raise HTTPException(status_code=403, detail="Module belongs to a different office")
    stage = int(m.get("stage") or 0)
    uid = str(user.get("id") or user.get("_id") or "")
    if role == "admin":
        if not await _target_in_scope(user, target_user_id):
            raise HTTPException(status_code=403, detail="Target belongs to a different office")
    elif role == "leader":
        # Leader may pass off a target in their subtree
        if not await _target_in_scope(user, target_user_id):
            raise HTTPException(status_code=403, detail="Target belongs to a different office")
        sub = await get_subtree_ids(uid)
        if target_user_id not in sub or target_user_id == uid:
            raise HTTPException(status_code=403, detail="Pass-off needs a higher-stage coach or an admin")
    else:
        raise HTTPException(status_code=403, detail="Coach/admin only")

    existing = await db.module_progress.find_one({
        "$or": [
            {"target_user_id": target_user_id, "module_id": module_id},
            {"user_id": target_user_id, "module_id": module_id, "target_user_id": {"$exists": False}},
        ],
    })
    update = {
        "passed_off": bool(body.passed_off),
        "passed_off_by_id": uid if body.passed_off else None,
        "passed_off_at": _now_iso() if body.passed_off else None,
        "passed_off_note": body.note if body.passed_off else None,
        "target_user_id": target_user_id,
        "last_assessed_at": _now_iso(),
    }
    # A coach signing (or declining) a rung resolves the pending check.
    # Pass-off resolves any pending check — the coach just signed the row.
    update["ready_for_check"] = False
    merged = {**(existing or {}), **update}
    update["completed"] = _compute_completed(merged)

    if existing:
        await db.module_progress.update_one({"_id": existing["_id"]}, {"$set": update})
        out = {**existing, **update}
    else:
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": target_user_id,
            "target_user_id": target_user_id,
            "module_id": module_id,
            "stage": stage,
            **update,
        }
        await db.module_progress.insert_one(doc)
        out = doc
    if update["completed"]:
        try:
            await award_module_stage_completion(target_user_id, stage)
        except Exception as exc:
            logger.warning("module stage achievement award failed for %s: %s", target_user_id, exc)
        await _sales_path_recompute(target_user_id, stage)
    return _normalise_progress_row(out)


# ─────────────────────── Stage-1 daily-assessment pass-off ─────────────────


@router.post("/daily-assessments/{assessment_id}/pass-off")
async def pass_off_daily(assessment_id: str, body: PassOffBody, request: Request):
    """Pass-off a Stage-1 day. Locks an over-rule above the original assessor.

    Two callers share this route:
      • Leader/admin — the original pass-off (sets passed_off/by/at and forces
        completed).
      • The trainee who OWNS the day — "I've read my feedback": sets
        acknowledged/acknowledged_at ONLY. passed_off stays a leader-exclusive
        signal, so the two flags never blur into each other.
    """
    user = await get_current_user(request)
    role = (user.get("role") or "").lower()
    a = await db.daily_assessments.find_one({"id": assessment_id})
    if not a:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if role not in ("leader", "admin"):
        # Trainee-owner acknowledgement path. Ownership = the hire linked to
        # this account (either direction of the user↔new_hire link).
        uid = str(user.get("id") or user.get("_id") or "")
        owns = bool(user.get("new_hire_id")) and user.get("new_hire_id") == a.get("new_hire_id")
        if not owns and uid:
            hire = await db.new_hires.find_one(
                {"id": a.get("new_hire_id", "")}, {"trainee_user_id": 1}
            )
            owns = bool((hire or {}).get("trainee_user_id")) and (hire or {}).get("trainee_user_id") == uid
        if not owns:
            raise HTTPException(status_code=403, detail="Coach/admin only")
        if not a.get("completed"):
            raise HTTPException(status_code=400, detail="This day hasn't been graded yet")
        await db.daily_assessments.update_one(
            {"id": assessment_id},
            {"$set": {"acknowledged": True, "acknowledged_at": _now_iso()}},
        )
        return {"ok": True, "acknowledged": True}
    # Every non-super manager must control the hire. This also office-scopes
    # ordinary admins instead of treating the admin role as country-wide.
    from auth import can_access_hire
    if not user.get("is_super_admin") and not await can_access_hire(user, a.get("new_hire_id", "")):
        raise HTTPException(status_code=403, detail="Not in your team or office")
    uid = str(user.get("id") or user.get("_id") or "")
    upd = {
        "passed_off": bool(body.passed_off),
        "passed_off_by_id": uid if body.passed_off else None,
        "passed_off_at": _now_iso() if body.passed_off else None,
        "passed_off_note": body.note if body.passed_off else None,
    }
    if body.passed_off:
        # Treat as completed if not already
        upd["completed"] = True
        upd["status"] = a.get("status") or "Passed Off"
        # Completion needs a fixed date: the sales-path training cutoff reads
        # assessment_date, and a completed day 8 without one used to leave
        # the Green Week cutoff unresolvable.
        if not a.get("completed") and not a.get("assessment_date"):
            upd["assessment_date"] = _now_iso()
    await db.daily_assessments.update_one({"id": assessment_id}, {"$set": upd})
    if body.passed_off:
        try:
            hire = await db.new_hires.find_one(
                {"id": a.get("new_hire_id")}, {"trainee_user_id": 1}
            )
            trainee_user_id = (hire or {}).get("trainee_user_id")
            if trainee_user_id:
                await award_stage1_milestones(a["new_hire_id"], trainee_user_id)
        except Exception as exc:
            logger.warning("stage1 achievement award failed after pass-off: %s", exc)
    return {"ok": True, "passed_off": bool(body.passed_off)}


# ──────────────────────── stage status ─────────────────────────────────────


@router.get("/stage-status/me")
async def my_stage_status(request: Request):
    """Returns visibility + lock state for every stage for the current user.

    Visibility (`stage_X_visible`) drives the soft-lock chase UX — the UI
    SHOWS the next stage as a teaser even when it's not yet unlocked. Hidden
    stages are entirely absent (e.g. trainees never see Stage 4).
    """
    user = await get_current_user(request)
    role = (user.get("role") or "").lower()
    hire_id = user.get("new_hire_id")
    is_trainee = role == "trainee" or bool(hire_id)
    is_leader = role == "leader"
    is_admin = role == "admin"
    days_submitted: list = []
    days_completed: list = []
    days_passed_off: list = []
    if hire_id:
        days_submitted = await db.daily_assessments.distinct(
            "day_number", {"new_hire_id": hire_id}
        )
        # Completed (graded) days — this is the ACTUAL Stage-2 gate
        # (_is_stage_unlocked), so the UI counter must mirror it.
        days_completed = await db.daily_assessments.distinct(
            "day_number", {"new_hire_id": hire_id, "completed": True}
        )
        days_passed_off = await db.daily_assessments.distinct(
            "day_number", {"new_hire_id": hire_id, "passed_off": True}
        )

    s2_unlocked = await _is_stage_unlocked(user, 2)
    s3_unlocked = await _is_stage_unlocked(user, 3)
    s4_unlocked = await _is_stage_unlocked(user, 4)
    s5_unlocked = await _is_stage_unlocked(user, 5)
    has_junior = is_leader and await _team_has_junior_leader(user)

    # Visibility rules:
    #  • Trainees see Stage 2 (locked or active) and Stage 3 (always locked teaser); Stage 4 hidden.
    #  • Leaders see Stages 2/3 (Stage 3 may be locked teaser); Stage 4 hidden.
    #  • Admins see everything.
    if is_admin:
        s2_visible, s3_visible, s4_visible = True, True, True
    elif is_leader:
        s2_visible, s3_visible, s4_visible = True, True, False
    elif is_trainee:
        s2_visible, s3_visible, s4_visible = True, True, False
    else:
        s2_visible, s3_visible, s4_visible = False, False, False

    # Sales Development Path — sibling keys on the oracle every COD screen
    # already polls. Stored-doc read only (the write hooks + /sales-path/me
    # keep it fresh); nothing here recomputes.
    sales_path_on = False
    sales_level = None
    sales_level_name = None
    ramp_status = None
    ramp_week = None
    try:
        from core.sales_path import sales_path_office_enabled
        sales_path_on = sales_path_office_enabled(user.get("office_id"))
        if sales_path_on:
            sp = await db.sales_path.find_one(
                {"user_id": str(user.get("id"))},
                {"_id": 0, "level": 1, "level_name": 1, "ramp": 1},
            )
            if sp:
                sales_level = sp.get("level")
                sales_level_name = sp.get("level_name")
                ramp_status = (sp.get("ramp") or {}).get("status")
                ramp_week = (sp.get("ramp") or {}).get("week")
    except Exception:
        logger.exception("stage-status: sales-path lookup failed (continuing)")

    return {
        "is_trainee": is_trainee,
        "is_leader": is_leader,
        "is_admin": is_admin,
        "is_leader_or_admin": is_leader or is_admin,
        "team_has_junior_leader": has_junior,
        "stage_1_days_submitted": sorted(days_submitted or []),
        "stage_1_days_completed": sorted(days_completed or []),
        "stage_1_days_passed_off": sorted(days_passed_off or []),
        "stage_1_total_days": 8,
        "stage_2_visible": s2_visible,
        "stage_3_visible": s3_visible,
        "stage_4_visible": s4_visible,
        # Stage SL (5) shows for, and is unlocked for, leaders/admins.
        "stage_5_visible": is_leader or is_admin,
        "stage_2_unlocked": s2_unlocked,
        "stage_3_unlocked": s3_unlocked,
        "stage_4_unlocked": s4_unlocked,
        "stage_5_unlocked": s5_unlocked,
        "sales_path_enabled": sales_path_on,
        "sales_level": sales_level,
        "sales_level_name": sales_level_name,
        "ramp_status": ramp_status,
        "ramp_week": ramp_week,
    }


# ─────────────────────────── COD stage videos ──────────────────────────────
# Cloudinary-hosted intro videos shown at the top of each COD stage (the
# "watch this first" briefing). URLs live in a single settings doc so they
# can be swapped without a deploy. SL has no video (by design, Aug 2026).

_COD_VIDEO_KEYS = ("intro", "stage1", "stage2", "stage3", "stage4", "stage5")


@router.get("/cod/videos")
async def get_cod_videos(request: Request):
    """Video URLs per COD stage — any authenticated user."""
    await get_current_user(request)
    doc = await db.cod_videos.find_one({"_id": "cod_videos"}) or {}
    return {k: doc.get(k) or None for k in _COD_VIDEO_KEYS}


class CodVideosUpdate(BaseModel):
    intro: Optional[str] = None
    stage1: Optional[str] = None
    stage2: Optional[str] = None
    stage3: Optional[str] = None
    stage4: Optional[str] = None
    stage5: Optional[str] = None


@router.put("/cod/videos")
async def set_cod_videos(payload: CodVideosUpdate, request: Request):
    """Admin-only: set/replace stage video URLs. Empty string clears a slot."""
    user = await get_current_user(request)
    if (user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    update = {k: (v.strip() or None) for k, v in payload.model_dump(exclude_none=True).items()}
    await db.cod_videos.update_one({"_id": "cod_videos"}, {"$set": update}, upsert=True)
    doc = await db.cod_videos.find_one({"_id": "cod_videos"}) or {}
    return {k: doc.get(k) or None for k in _COD_VIDEO_KEYS}


# ─────────────────────────── COD vetting (admins) ──────────────────────────
# The leadership team walks every COD module step by step — approve as-is or
# edit wording/targets — and each save writes to EVERY office copy plus the
# global template (matched by stage+topic), so both cities stay aligned and
# the curriculum remains scalable. Vetting state (who/when) is tracked per
# (stage, topic).

_VETTABLE_FIELDS = {"topic", "trainee_content", "what_good_looks_like",
                    "how_measured", "leader_coaching_notes"}


@router.get("/cod/vetting")
async def cod_vetting_list(request: Request):
    """Every live COD module (stages 1-5), one entry per (stage, topic),
    with vetted state. Content is read from the admin's own office copy —
    all copies are kept aligned by the PUT below."""
    user = await get_current_user(request)
    if (user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    office_id = user.get("office_id")
    await _ensure_seeded(office_id)
    rows = []
    async for m in db.training_modules.find(
        {"office_id": office_id, "stage": {"$in": [1, 2, 3, 4, 5]}, "retired": {"$ne": True}},
    ):
        rows.append({
            "stage": m.get("stage"), "category": m.get("category"), "topic": m.get("topic"),
            "sequence": m.get("sequence", 0),
            "trainee_content": m.get("trainee_content") or "",
            "what_good_looks_like": m.get("what_good_looks_like") or [],
            "how_measured": m.get("how_measured") or [],
            "leader_coaching_notes": m.get("leader_coaching_notes") or [],
            "vetted_by": m.get("cod_vetted_by"), "vetted_at": m.get("cod_vetted_at"),
        })
    # COD display order — the vetting stepper walks 1, 2, 3, SL, 4. SL is
    # STORED as stage 5 and stays 5; only the emitted order changes.
    rows.sort(key=lambda r: (cod_stage_rank(r["stage"]), r["sequence"]))
    return {"modules": rows}


class CodVetBody(BaseModel):
    stage: int = Field(..., ge=1, le=5)
    topic: str
    updates: Optional[dict] = None   # subset of _VETTABLE_FIELDS
    vetted: bool = True


@router.put("/cod/vetting")
async def cod_vet_module(payload: CodVetBody, request: Request):
    """Approve (and optionally edit) one COD module ACROSS ALL SCOPES —
    every office plus the global template gets the same content, keyed by
    (stage, topic). A topic rename propagates too."""
    user = await get_current_user(request)
    if (user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    updates = {k: v for k, v in (payload.updates or {}).items() if k in _VETTABLE_FIELDS}
    for k in ("what_good_looks_like", "how_measured", "leader_coaching_notes"):
        if k in updates:
            updates[k] = [str(x).strip() for x in (updates[k] or []) if str(x).strip()]
    if "topic" in updates:
        updates["topic"] = str(updates["topic"]).strip()
        if not updates["topic"]:
            updates.pop("topic")
    if "trainee_content" in updates:
        updates["trainee_content"] = str(updates["trainee_content"]).strip()
    if payload.vetted:
        updates["cod_vetted_by"] = user.get("name") or user.get("email") or "admin"
        updates["cod_vetted_at"] = _now_iso()
    r = await db.training_modules.update_many(
        {"stage": payload.stage, "topic": payload.topic, "retired": {"$ne": True}},
        {"$set": updates},
    )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Module not found")
    return {"updated_copies": r.modified_count, "matched": r.matched_count}


# ──────────────────── "Ready for check" + the check queue ──────────────────
# The sign-off loop, Absorb-style: the learner taps ONE button when they can
# prove the next rung; the item lands in their coach's queue; the coach
# confirms (writes the ladder — date stamps itself) or taps "not yet". No
# forms, no manual dates, no separate review destination.


class ReadyBody(BaseModel):
    ready: bool = True
    target_user_id: Optional[str] = None   # coach clearing someone else's flag
    note: Optional[str] = None             # optional one-liner on "not yet"


@router.post("/module-progress/{module_id}/ready")
async def set_ready_for_check(module_id: str, payload: ReadyBody, request: Request):
    """Set/clear the ready-for-check flag. Anyone may raise it on their OWN
    row (trainees included — this is their only write). Clearing someone
    else's flag ("not yet") requires grading rights over them."""
    user = await get_current_user(request)
    uid = str(user.get("id") or user.get("_id") or "")
    target = payload.target_user_id or uid
    m = await db.training_modules.find_one({"id": module_id})
    if not m:
        raise HTTPException(status_code=404, detail="Module not found")
    # Same office/stage read gate as every other module endpoint — a flag on
    # a module you cannot read would leak its coach-only content into a
    # queue and could never be resolved.
    await _check_module_read(user, m)
    if payload.ready:
        existing_row = await db.module_progress.find_one({
            "$or": [
                {"target_user_id": target, "module_id": module_id},
                {"user_id": target, "module_id": module_id, "target_user_id": {"$exists": False}},
            ],
        }, {"ladder": 1})
        if int((existing_row or {}).get("ladder") or 0) >= _max_rung_for_stage(int(m.get("stage") or 0)):
            raise HTTPException(status_code=400, detail="This capability is already at its top rung for this stage")
    if target != uid:
        if not await _user_can_grade_target(user, target, int(m.get("stage") or 0)):
            raise HTTPException(status_code=403, detail="Not allowed for this user")
    upd: dict = {
        "ready_for_check": bool(payload.ready),
        "ready_at": _now_iso() if payload.ready else None,
    }
    if payload.note is not None and target != uid:
        upd["leader_notes"] = str(payload.note)[:500]
    existing = await db.module_progress.find_one({
        "$or": [
            {"target_user_id": target, "module_id": module_id},
            {"user_id": target, "module_id": module_id, "target_user_id": {"$exists": False}},
        ],
    })
    if existing:
        await db.module_progress.update_one({"_id": existing["_id"]}, {"$set": upd})
        return _normalise_progress_row({**existing, **upd})
    doc = {
        "id": str(uuid.uuid4()), "user_id": target, "target_user_id": target,
        "module_id": module_id, "stage": int(m.get("stage") or 0), **upd,
    }
    await db.module_progress.insert_one(doc)
    return _normalise_progress_row(doc)


@router.get("/cod/checks")
async def pending_checks(request: Request):
    """The coach's queue: everyone in my scope who tapped "Ready for check",
    with the module context a coach needs at the moment of signing — the
    WGLL criteria to check against, how it's measured, coaching notes."""
    user = await get_current_user(request)
    role = (user.get("role") or "").lower()
    if role not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    uid = str(user.get("id") or user.get("_id") or "")
    q: dict = {"ready_for_check": True}
    if role != "admin":
        allowed = set(await get_subtree_ids(uid)) - {uid}
        if not allowed:
            return {"checks": []}
        # Scope in the QUERY, so someone else's backlog can never crowd this
        # coach's items out of the limit window.
        q["$or"] = [
            {"target_user_id": {"$in": list(allowed)}},
            {"target_user_id": {"$exists": False}, "user_id": {"$in": list(allowed)}},
        ]

    rows = []
    async for p in db.module_progress.find(q).sort("ready_at", 1).limit(500):
        target = p.get("target_user_id") or p.get("user_id")
        if not target or target == uid:
            continue
        rows.append(_normalise_progress_row(p))

    # Join people + modules in two round-trips.
    user_ids, module_ids = set(), set()
    for r in rows:
        user_ids.add(r.get("target_user_id")); module_ids.add(r.get("module_id"))
    people = {}
    obj_ids = []
    for t in user_ids:
        try:
            obj_ids.append(ObjectId(t))
        except Exception:
            pass
    async for u in db.users.find({"_id": {"$in": obj_ids}}, {"name": 1, "role": 1, "office_id": 1}):
        people[str(u["_id"])] = u
    mods = {}
    async for m in db.training_modules.find({"id": {"$in": list(module_ids)}}):
        mods[m["id"]] = m

    out = []
    grade_cache: dict = {}
    for r in rows:
        u = people.get(r.get("target_user_id"))
        m = mods.get(r.get("module_id"))
        if not u or not m:
            continue
        if role == "admin" and not user.get("is_super_admin") and u.get("office_id") != user.get("office_id"):
            continue
        # Never list a check this viewer cannot resolve (e.g. a plain leader
        # seeing a stage-4/SL claim only an admin may sign) — an unresolvable
        # card would sit in the queue forever and inflate the badge.
        gkey = (r.get("target_user_id"), int(m.get("stage") or 0))
        if gkey not in grade_cache:
            grade_cache[gkey] = await _user_can_grade_target(user, gkey[0], gkey[1])
        if not grade_cache[gkey]:
            continue
        if int(r.get("ladder") or 0) >= _max_rung_for_stage(int(m.get("stage") or 0)):
            continue  # already topped out — stale flag, nothing to sign
        out.append({
            "kind": "module",
            "target_user_id": r.get("target_user_id"),
            "target_name": u.get("name"),
            "target_role": u.get("role"),
            "module_id": r.get("module_id"),
            "stage": m.get("stage"),
            "category": m.get("category"),
            "topic": m.get("topic"),
            "ladder": int(r.get("ladder") or 0),
            "next_rung": min(_max_rung_for_stage(int(m.get("stage") or 0)), int(r.get("ladder") or 0) + 1),
            "ready_at": r.get("ready_at"),
            "wgll": m.get("what_good_looks_like") or [],
            "wgll_checked": r.get("wgll_checked") or [],
            # The leader panel — coach-only context at the moment of signing.
            "how_measured": m.get("how_measured") or [],
            "coaching_notes": m.get("leader_coaching_notes") or [],
        })

    # ── Sales-path Expert/Mastery claims — same queue, second card kind ──
    # Expert is signable by any coach in scope; Mastery cards only show to
    # admins (never list a check the viewer can't resolve). Data eligibility
    # is re-validated at sign time by the sales-path endpoint, so a stale
    # card can be tapped but never wrongly signed.
    try:
        from core.sales_path import sales_path_office_enabled
        sp_q: dict = {"$or": [{"expert_ready_for_check": True}, {"mastery_ready_for_check": True}]}
        if role != "admin":
            allowed = set(await get_subtree_ids(uid)) - {uid}
            if allowed:
                sp_q["user_id"] = {"$in": list(allowed)}
            else:
                sp_q = None
        elif not user.get("is_super_admin"):
            # Pre-filter by the stored office stamp so another office's
            # backlog can't fill the limit window (same scope-in-the-query
            # rule as module cards). The live-user check below stays the
            # authority — the stamp refreshes on recompute and can be stale.
            sp_q["office_id"] = user.get("office_id")
        if sp_q:
            async for sp in db.sales_path.find(sp_q, {"_id": 0}).sort("updated_at", 1).limit(100):
                t = sp.get("user_id")
                if not t or t == uid:
                    continue
                u = people.get(t)
                if not u or "is_active" not in u:
                    try:
                        u = await db.users.find_one(
                            {"_id": ObjectId(t)},
                            {"name": 1, "role": 1, "office_id": 1, "is_active": 1, "deleted": 1},
                        )
                    except Exception:
                        u = None
                if not u or u.get("deleted") or u.get("is_active") is False:
                    continue
                # Office gate for EVERY non-super viewer (a transferred rep's
                # reports_to can still point across the office boundary), and
                # the feature flag keys on the LIVE office, never the stamp.
                if not user.get("is_super_admin") and u.get("office_id") != user.get("office_id"):
                    continue
                if not sales_path_office_enabled(u.get("office_id")):
                    continue
                for level, field in ((5, "expert"), (6, "mastery")):
                    if not sp.get(f"{field}_ready_for_check"):
                        continue
                    if level == 6 and role != "admin":
                        continue  # Mastery is admin-signed
                    out.append({
                        "kind": "sales_level",
                        "target_user_id": t,
                        "target_name": u.get("name"),
                        "target_role": u.get("role"),
                        "level": level,
                        "level_name": "Expert" if level == 5 else "Mastery",
                        "ready_at": sp.get(f"{field}_ready_at"),
                        "windows": sp.get("expert_windows") or [],
                        "form": sp.get("form") or {},
                        "green_weeks": sp.get("green_weeks"),
                        "data_eligible": bool(sp.get(f"{field}_data_eligible")),
                    })
    except Exception:
        logger.exception("cod/checks: sales-path claims lookup failed (continuing)")

    return {"checks": out}


async def pregenerate_module_quizzes(limit: int = 25) -> dict:
    """Background quiz pre-generation — the reason tapping "Check your
    understanding" is instant. Walks live modules whose current content has
    no quiz yet (content edits change the hash, so vetting a module queues
    its quiz for regeneration automatically) and generates up to `limit` per
    tick to stay inside LLM rate limits."""
    import hashlib
    made = skipped = 0
    async for m in db.training_modules.find({"retired": {"$ne": True}, "stage": {"$in": [2, 3, 4, 5]}}):
        if made >= limit:
            break
        content = (m.get("trainee_content") or "").strip()
        if len(content) < 60:
            continue
        good = m.get("what_good_looks_like") or []
        extra = "\n".join(str(x) for x in good) if isinstance(good, list) else str(good)
        h = hashlib.sha1((content + "\n" + extra).encode("utf-8")).hexdigest()[:16]
        if await db.module_quizzes.find_one({"module_id": m["id"], "content_hash": h}, {"_id": 1}):
            skipped += 1
            continue
        q = await _get_or_create_quiz(m)
        if q:
            made += 1
    return {"generated": made, "already_had": skipped}
