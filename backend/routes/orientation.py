"""Orientation bulk grading — mark the whole Monday class at once.

99/100 new hires are "Excellent and Learnt" on orientation Days 1–2, so
grading them one by one is 5 minutes of ceremony per person. This router
powers the admin flow behind the 6 PM orientation nudge (and the Unassigned
tab of My Team):

    GET  /api/orientation/cohort?day=1|2   — who still needs Day-N grading
    POST /api/orientation/bulk-grade       — Excellent-preset everyone ticked

The EXCELLENT PRESET per hire:
    • every behaviour rating field = 10
      (behaviour_punctuality/engagement/image/coachability/attitude)
    • Day 2 only: every skill rating field = 10
      (skill_intro/presentation/short_story/close/signup/rehash)
    • every delivery_checklist row of the day's assessment → grade "Learnt"
      when its grade_options contain it, else grade_options[0];
      taught=True, outcome_achieved=True
Per-hire overrides (from the Edit screen) are applied ON TOP of the preset —
assessment fields replace preset values, checklist grades replace per-row.

Completion then goes through routes.training_routes.update_assessment — the
EXACT code path the single grader uses — so score recompute (incl. checklist
grade), completed/status, current_day advance, the trainee "day ready" push
and Stage-1 achievements all behave identically to a manual grade. Nothing
here re-implements that logic.

Hires whose Day-N assessment is already completed are skipped (ok=false,
detail "already graded") and never rewritten; invalid overrides fail that
hire BEFORE any write, leaving them untouched.

Office scoping: plain admins are pinned to their own office; super-admins
may pass ?office= on the cohort read and may bulk-grade across offices.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from database import db
from auth import require_admin
from models import DailyAssessmentUpdate
from core.office_helpers import resolve_office_id
from core.orientation_nudge import ORIENTATION_DAYS, cohort_for_office
from routes.training_routes import update_assessment

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/orientation")

# Assessment field names an override may set — everything the single grader's
# PUT accepts except the completion flag (bulk-grade owns that transition).
_OVERRIDABLE_FIELDS = frozenset(
    (getattr(DailyAssessmentUpdate, "model_fields", None) or DailyAssessmentUpdate.__fields__).keys()
) - {"completed"}

# The Excellent preset: every behaviour rating maxed; Day 2 adds every skill
# rating (Day 1 has no skill block — scoring ignores skills there anyway).
# customer_service is NOT preset: orientation days 1-2 are office days and
# that expectation only applies on field days.
BEHAVIOUR_FIELDS = (
    "behaviour_punctuality",
    "behaviour_engagement",
    "behaviour_image",
    "behaviour_coachability",
    "behaviour_attitude",
    "behaviour_comfort_zones",
)
SKILL_FIELDS = (
    "skill_intro",
    "skill_presentation",
    "skill_short_story",
    "skill_close",
    "skill_signup",
    "skill_rehash",
)
PRESET_CHECKLIST_GRADE = "Learnt"


class HireOverride(BaseModel):
    """Per-hire edits layered on top of the Excellent preset."""
    assessment: Dict[str, Any] = {}
    checklist: Dict[str, str] = {}  # checklist row id -> grade string


class BulkGradeBody(BaseModel):
    day: int
    hire_ids: List[str]
    overrides: Dict[str, HireOverride] = {}


def _require_day(day: int) -> None:
    if day not in ORIENTATION_DAYS:
        raise HTTPException(status_code=400, detail="day must be 1 or 2")


def _excellent_preset(day: int) -> dict:
    fields = {f: 10 for f in BEHAVIOUR_FIELDS}
    if day == 2:
        fields.update({f: 10 for f in SKILL_FIELDS})
    return fields


def _preset_grade(row: dict) -> str:
    opts = row.get("grade_options") or []
    if PRESET_CHECKLIST_GRADE in opts:
        return PRESET_CHECKLIST_GRADE
    return opts[0] if opts else PRESET_CHECKLIST_GRADE


@router.get("/cohort")
async def get_orientation_cohort(request: Request, day: int, office: Optional[str] = None):
    """The Day-N orientation grading cohort for the caller's office (super-admin
    may pass ?office=). Empty list is normal — everyone's already graded."""
    user = await require_admin(request)
    _require_day(day)
    office_id = await resolve_office_id(request, user, office)
    items = await cohort_for_office(office_id, day)
    return {"day": day, "items": items}


async def _grade_one(hire_id: str, day: int, override: HireOverride, user: dict, request: Request) -> Optional[str]:
    """Preset + overrides + completion for one hire. Returns None on success,
    a human-readable failure detail otherwise. All validation happens BEFORE
    any write so a failed hire is left untouched."""
    hire = await db.new_hires.find_one({"id": hire_id})
    if not hire:
        return "new starter not found"
    if not user.get("is_super_admin") and hire.get("office_id") != user.get("office_id"):
        return "not in your office"

    assessment = await db.daily_assessments.find_one({"new_hire_id": hire_id, "day_number": day})
    if not assessment:
        return f"no day {day} assessment"
    if assessment.get("completed"):
        return "already graded"

    # Assessment fields: preset, then overrides on top — validated through the
    # same pydantic model the single grader's PUT uses.
    fields = _excellent_preset(day)
    unknown = set(override.assessment) - _OVERRIDABLE_FIELDS
    if unknown:
        return f"unknown assessment field(s): {', '.join(sorted(unknown))}"
    fields.update(override.assessment)
    try:
        update_model = DailyAssessmentUpdate(**fields, completed=True)
    except Exception:
        return "invalid assessment override value"

    # Checklist rows: validate overrides against the real rows before writing.
    rows = await db.delivery_checklist.find({"assessment_id": assessment["id"]}).to_list(100)
    rows_by_id = {r["id"]: r for r in rows}
    for row_id, grade in override.checklist.items():
        row = rows_by_id.get(row_id)
        if not row:
            return f"unknown checklist row: {row_id}"
        opts = row.get("grade_options") or []
        if opts and grade not in opts:
            return f"invalid grade '{grade}' for checklist row {row_id}"

    # Writes: every row gets the preset grade + flags, overrides replace per-row.
    for row in rows:
        grade = override.checklist.get(row["id"], _preset_grade(row))
        await db.delivery_checklist.update_one(
            {"id": row["id"]},
            {"$set": {"grade": grade, "taught": True, "outcome_achieved": True}},
        )

    # Complete through the single grader's code path — score recompute
    # (incl. checklist grade), completed/status, current_day advance,
    # trainee push, achievements.
    try:
        await update_assessment(assessment["id"], update_model, request)
    except HTTPException as e:
        return str(e.detail)
    return None


@router.post("/bulk-grade")
async def bulk_grade_orientation(body: BulkGradeBody, request: Request):
    user = await require_admin(request)
    _require_day(body.day)
    if not user.get("is_super_admin") and not user.get("office_id"):
        raise HTTPException(status_code=403, detail="Your account is not assigned to an office")

    results: list[dict] = []
    graded = 0
    skipped = 0
    seen: set[str] = set()
    for hire_id in body.hire_ids:
        if hire_id in seen:
            continue  # a duplicate tick must not double-grade (or double-count)
        seen.add(hire_id)
        override = body.overrides.get(hire_id) or HireOverride()
        try:
            detail = await _grade_one(hire_id, body.day, override, user, request)
        except Exception as e:
            logger.error(f"orientation bulk-grade failed for {hire_id}: {e}")
            detail = "grading failed"
        if detail is None:
            graded += 1
            results.append({"hire_id": hire_id, "ok": True, "detail": None})
        else:
            skipped += 1
            results.append({"hire_id": hire_id, "ok": False, "detail": detail})

    logger.info(
        f"orientation bulk-grade day {body.day} by {user.get('id')}: {graded} graded / {skipped} skipped"
    )
    return {"graded": graded, "skipped": skipped, "results": results}
