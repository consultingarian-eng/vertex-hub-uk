"""Trainee training-record bootstrap — the one place that builds a new
trainee's 8-day record.

Every path that adds a trainee (POST /new-hires from the Add Trainee screen,
POST /admin/create-user, POST /auth/register, and the admin repair tool for
trainee accounts that have no record) calls these helpers, so a trainee always
lands with:

  * a `new_hires` row (the trainee's training record), and
  * one Pending `daily_assessments` row per training day (Day 1–8), each with
    `delivery_checklist` rows copied from the office's `training_manual`.

The database handle is passed in by the caller so route modules (and their
unit tests, which monkeypatch the route module's `db`) stay in control of
which database is written.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

TRAINING_DAYS = range(1, 9)

# Every scored field of a daily assessment, blank until a leader grades it.
BLANK_ASSESSMENT_FIELDS = {
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

DEFAULT_GRADE_OPTIONS = ["Excellent", "Average", "Below Average"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def create_assessment_skeleton(db, hire_id: str, name: str, office_id: Optional[str],
                                     days=TRAINING_DAYS) -> list[str]:
    """Insert one Pending daily assessment per day (default Day 1–8) plus the
    matching delivery-checklist rows from the office's training manual.
    Returns the new assessment ids in day order."""
    ids: list[str] = []
    for day in days:
        aid = str(uuid.uuid4())
        await db.daily_assessments.insert_one({
            "id": aid, "new_hire_id": hire_id, "new_hire_name": name,
            "day_number": day, **BLANK_ASSESSMENT_FIELDS,
        })
        ids.append(aid)
        manual_items = await db.training_manual.find(
            {"day_number": day, "office_id": office_id}
        ).sort("sequence", 1).to_list(500)
        for item in manual_items:
            await db.delivery_checklist.insert_one({
                "id": str(uuid.uuid4()), "assessment_id": aid,
                # office_id is stamped so grade-option propagation stays
                # office-scoped (rows without it are legacy; core/content_fixes
                # backfills those via the assessment → hire join at startup).
                "office_id": office_id,
                "manual_item_id": f"D{day}-{int(item.get('sequence') or 0):02d}",
                "topic": item.get("topic"), "category": item.get("category"),
                "confidence_expected": item.get("confidence_expected", "Understand"),
                "taught": False, "outcome_achieved": False, "confidence_level": "Not yet",
                "grade": None,
                "grade_options": item.get("grade_options", DEFAULT_GRADE_OPTIONS),
                "notes": None,
            })
    return ids


def build_new_hire_doc(*, name: str, office_id: Optional[str], leader_name: str = "Unassigned",
                       start_date: Optional[str] = None, campaign: str = "", notes: str = "",
                       trainee_user_id: Optional[str] = None,
                       leader_user_id: Optional[str] = None) -> dict:
    """A fresh `new_hires` document (Week 1, Day 1, In Progress).

    `leader_user_id` is the coach's user id. `leader` is only their display
    name: who may open the record is decided by ids (trainee_user_id, then
    leader_user_id), never by the name."""
    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "leader": leader_name or "Unassigned",
        "start_date": start_date or datetime.now(timezone.utc).date().isoformat(),
        "campaign": campaign or "",
        "phase": "Week 1",
        "current_day": 1,
        "current_status": "In Progress",
        "final_outcome": None,
        "active": True,
        "notes": notes or "",
        "office_id": office_id,
        "trainee_user_id": trainee_user_id,
        "leader_user_id": leader_user_id,
        "created_at": _now_iso(),
    }


def coach_hire_filter(hire_ids: list, coach_ids: list, legacy_leader_names: list) -> list[dict]:
    """The `$or` that picks the new-starter records a Coach may see.

    By stable id: a record linked to a trainee account in their tree
    (`hire_ids`), or an account-less record whose `leader_user_id` is them or
    someone under them (`coach_ids`). The coach's display NAME only matches
    legacy rows that carry neither id; names are not identities."""
    unlinked = {"$or": [{"trainee_user_id": None}, {"trainee_user_id": {"$exists": False}}]}
    no_leader_id = {"$or": [{"leader_user_id": None}, {"leader_user_id": {"$exists": False}}]}
    return [
        {"id": {"$in": list(hire_ids)}},
        {"$and": [unlinked, {"leader_user_id": {"$in": [str(i) for i in coach_ids]}}]},
        {"$and": [{"leader": {"$in": [n for n in legacy_leader_names if n]}}, unlinked, no_leader_id]},
    ]


async def create_training_record(db, *, name: str, office_id: Optional[str],
                                  trainee_user_id: Optional[str] = None,
                                  leader_name: str = "Unassigned",
                                  start_date: Optional[str] = None,
                                  campaign: str = "", notes: str = "") -> dict:
    """Create the trainee's `new_hires` row plus the Day 1–8 assessments and
    checklists. When a trainee user id is given, the user is back-linked via
    `users.new_hire_id`. Returns the inserted hire document."""
    hire = build_new_hire_doc(
        name=name, office_id=office_id, leader_name=leader_name,
        start_date=start_date, campaign=campaign, notes=notes,
        trainee_user_id=trainee_user_id,
    )
    await db.new_hires.insert_one(dict(hire))
    if trainee_user_id:
        from bson import ObjectId
        try:
            await db.users.update_one({"_id": ObjectId(trainee_user_id)},
                                      {"$set": {"new_hire_id": hire["id"]}})
        except Exception:
            pass  # non-ObjectId id (tests / legacy) — the hire still links back
    await create_assessment_skeleton(db, hire["id"], name, office_id)
    return hire
