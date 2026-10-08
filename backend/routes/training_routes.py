"""Training + team endpoints: new-hires, assessments, targets, training-manual, checklist,
dashboard, leaders, team tree, reports-to, sync-hierarchy, grade-presets, settings, commission-fees."""
import os
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional, List
from bson import ObjectId

from fastapi import APIRouter, HTTPException, Request

from database import db
from auth import (
    get_current_user, require_admin, require_super_admin, can_access_hire,
    get_subtree_ids, hash_password, MIN_PASSWORD_LENGTH,
)
from models import (
    NewHire, NewHireCreate, DailyAssessment, DailyAssessmentUpdate,
    DeliveryChecklist, DeliveryChecklistUpdate, ReassignLeaderRequest,
    TargetUpdate, ManualItemUpdate, ManualItemCreate, ReorderRequest, BulkGradeUpdate,
)
from scoring import calculate_scores, calculate_checklist_grade, GRADE_PRESETS, GRADE_VALUES
from seed_data import DAY_TARGETS, TRAINING_MANUAL
from core.email_utils import send_new_hire_email, send_promotion_email
from core.push import send_push_to_user
from core.office_helpers import resolve_office_id, try_get_user, get_office_filter
from core.achievements import award, award_stage1_milestones, award_upline_core_leader
from core.trainee_records import build_new_hire_doc, coach_hire_filter, create_assessment_skeleton
from core.vertex_pay import ADMIN_ONLY_FEE_KEYS, normalize_fees, clean_fee_update

logger = logging.getLogger(__name__)
router = APIRouter()


class ManualItemCreateBody(ManualItemCreate):
    """ManualItemCreate plus an optional confidence_expected so new items can
    be created as Assisted/Independent instead of always 'Understand'."""
    confidence_expected: Optional[str] = None


async def _can_manage_hire(user: dict, hire: dict) -> bool:
    """Office admins are office-scoped; leaders/trainees use hierarchy rules."""
    if user.get("is_super_admin"):
        return True
    if user.get("role") == "admin":
        return bool(user.get("office_id")) and hire.get("office_id") == user.get("office_id")
    return await can_access_hire(user, hire.get("id", ""))


@router.post("/new-hires", response_model=NewHire)
async def create_new_hire(hire: NewHireCreate, request: Request):
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    if not hire.name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    if bool(hire.email) != bool(hire.password):
        raise HTTPException(status_code=400, detail="Email and password must be provided together")
    if hire.password and len(hire.password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    # Resolve leader: prefer leader_id (from picker), fallback to leader name
    leader_name = hire.leader
    leader_user_id = hire.leader_id
    leader_user = None
    if leader_user_id:
        try:
            leader_user = await db.users.find_one({
                "_id": ObjectId(leader_user_id),
                "role": {"$in": ["leader", "admin"]},
                "deleted": {"$ne": True},
                "is_active": {"$ne": False},
            })
        except Exception:
            leader_user = None
        if not leader_user:
            raise HTTPException(status_code=400, detail="Coach not found")
        leader_name = leader_user.get("name", hire.leader)
    elif leader_name:
        leader_user = await db.users.find_one({
            "name": leader_name,
            "role": {"$in": ["leader", "admin"]},
            "office_id": user.get("office_id"),
            "deleted": {"$ne": True},
            "is_active": {"$ne": False},
        })
        if leader_user:
            leader_user_id = str(leader_user["_id"])
    if not leader_user_id or not leader_user:
        raise HTTPException(status_code=400, detail="A valid coach is required")
    if not user.get("is_super_admin") and leader_user.get("office_id") != user.get("office_id"):
        raise HTTPException(status_code=403, detail="The coach must be in your office")
    if user.get("role") == "leader":
        allowed = set(await get_subtree_ids(user["id"]))
        allowed.add(user["id"])
        if leader_user_id not in allowed:
            raise HTTPException(status_code=403, detail="You can only add new starters to your own team")
    hire_office_id = leader_user.get("office_id") or user.get("office_id")
    if not hire_office_id:
        raise HTTPException(status_code=400, detail="A valid office is required")
    hire_dict = build_new_hire_doc(
        name=hire.name.strip(), office_id=hire_office_id, leader_name=leader_name,
        start_date=hire.start_date, campaign=hire.campaign or "", notes=hire.notes or "",
        leader_user_id=leader_user_id,
    )
    hire_id = hire_dict["id"]
    trainee_user_id = None
    if hire.email and hire.password:
        email = hire.email.strip().lower()
        existing = await db.users.find_one({"email": email})
        if existing:
            raise HTTPException(status_code=400, detail="Email already registered")
        trainee_data = {
            "email": email, "password_hash": hash_password(hire.password),
            "name": hire.name.strip(), "role": "trainee",
            "new_hire_id": hire_id, "office_id": hire_office_id,
            "email_verified": True,
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        res = await db.users.insert_one(trainee_data)
        trainee_user_id = str(res.inserted_id)
        await db.users.update_one({"_id": res.inserted_id}, {"$set": {"reports_to": leader_user_id}})
        try:
            await award(leader_user_id, "team_builder")
        except Exception as e:
            logger.error(f"team_builder award error: {e}")
    hire_dict["trainee_user_id"] = trainee_user_id
    await db.new_hires.insert_one(dict(hire_dict))
    await create_assessment_skeleton(db, hire_id, hire.name.strip(), hire_office_id)
    return NewHire(**hire_dict)

@router.get("/new-hires", response_model=List[NewHire])
async def get_new_hires(request: Request, active_only: bool = True, office: Optional[str] = None):
    user = await get_current_user(request)
    query = {"active": True} if active_only else {}
    if user["role"] == "trainee":
        # A trainee may inspect only their own onboarding record.  Previously
        # this endpoint fell through to an office-wide query.
        own_links = [{"trainee_user_id": user["id"]}]
        if user.get("new_hire_id"):
            own_links.append({"id": user["new_hire_id"]})
        query["$or"] = own_links
    elif user["role"] == "leader":
        # Use full subtree: get ALL leader names in subtree + hire IDs
        subtree_ids = await get_subtree_ids(user["id"])
        trainee_users = await db.users.find(
            {"_id": {"$in": [ObjectId(sid) for sid in subtree_ids]}, "role": "trainee", "is_active": {"$ne": False}},
            {"new_hire_id": 1}
        ).to_list(500)
        hire_ids = [u["new_hire_id"] for u in trainee_users if u.get("new_hire_id")]
        # Collect all leader/admin names in subtree (including self) in a SINGLE query
        leader_names = [user.get("name", "")]
        leader_users = await db.users.find(
            {"_id": {"$in": [ObjectId(sid) for sid in subtree_ids]}, "role": {"$in": ["leader", "admin"]}, "is_active": {"$ne": False}},
            {"name": 1}
        ).to_list(500)
        leader_names.extend([u.get("name", "") for u in leader_users if u.get("name")])
        query["$or"] = coach_hire_filter(hire_ids, list(subtree_ids) + [user["id"]], leader_names)
    if user.get("is_super_admin") and office:
        query["office_id"] = await resolve_office_id(request, user, office)
    elif not user.get("is_super_admin"):
        if not user.get("office_id"):
            raise HTTPException(status_code=403, detail="Your account is not assigned to an office")
        query["office_id"] = user["office_id"]
    hires = await db.new_hires.find(query).sort("created_at", -1).to_list(1000)
    if active_only and hires:
        # Exclude records whose linked user has since been deleted.
        # Covers legacy rows where trainee_user_id was None so delete_user
        # couldn't deactivate them via the old single-field filter.
        deleted_q: dict = {"deleted": True}
        if not user.get("is_super_admin") and user.get("office_id"):
            deleted_q["office_id"] = user["office_id"]
        deleted_raw = await db.users.find(deleted_q, {"name": 1, "new_hire_id": 1, "_id": 1}).to_list(500)
        del_names = {u["name"] for u in deleted_raw if u.get("name")}
        del_hire_ids = {u["new_hire_id"] for u in deleted_raw if u.get("new_hire_id")}
        del_user_ids = {str(u["_id"]) for u in deleted_raw}
        hires = [
            h for h in hires
            if h.get("name") not in del_names
            and h.get("id") not in del_hire_ids
            and (h.get("trainee_user_id") or "") not in del_user_ids
        ]
    return [NewHire(**h) for h in hires]

@router.get("/new-hires/{hire_id}", response_model=NewHire)
async def get_new_hire(hire_id: str, request: Request):
    user = await get_current_user(request)
    hire = await db.new_hires.find_one({"id": hire_id})
    if not hire:
        raise HTTPException(status_code=404, detail="New starter not found")
    if not await _can_manage_hire(user, hire):
        raise HTTPException(status_code=403, detail="You don't have access to this BA")
    return NewHire(**hire)

@router.put("/new-hires/{hire_id}/outcome")
async def set_final_outcome(hire_id: str, outcome: str, request: Request):
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    if outcome not in {"Ready", "Needs More Training", "Not Ready"}:
        raise HTTPException(status_code=400, detail="Invalid outcome")
    hire = await db.new_hires.find_one({"id": hire_id})
    if not hire:
        raise HTTPException(status_code=404, detail="New starter not found")
    if not await _can_manage_hire(user, hire):
        raise HTTPException(status_code=403, detail="You don't have access to this BA")
    result = await db.new_hires.update_one(
        {"id": hire_id},
        {"$set": {"final_outcome": outcome, "current_status": "Completed" if outcome else "In Progress"}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="New starter not found")
    return {"message": "Outcome updated"}

@router.delete("/new-hires/{hire_id}")
async def delete_new_hire(hire_id: str, request: Request):
    admin = await require_admin(request)
    hire = await db.new_hires.find_one({"id": hire_id})
    if not hire:
        raise HTTPException(status_code=404, detail="New starter not found")
    if not await _can_manage_hire(admin, hire):
        raise HTTPException(status_code=403, detail="You don't have access to this BA")
    assessments = await db.daily_assessments.find({"new_hire_id": hire_id}).to_list(100)
    for a in assessments:
        await db.delivery_checklist.delete_many({"assessment_id": a["id"]})
    await db.daily_assessments.delete_many({"new_hire_id": hire_id})
    await db.new_hires.delete_one({"id": hire_id})
    if hire.get("trainee_user_id"):
        await db.users.delete_one({"_id": ObjectId(hire["trainee_user_id"])})
    return {"message": "New starter deleted"}

@router.put("/new-hires/{hire_id}/reassign-leader")
async def reassign_leader(hire_id: str, req: ReassignLeaderRequest, request: Request):
    admin = await require_admin(request)
    hire = await db.new_hires.find_one({"id": hire_id})
    if not hire:
        raise HTTPException(status_code=404, detail="New starter not found")
    if not await _can_manage_hire(admin, hire):
        raise HTTPException(status_code=403, detail="You don't have access to this BA")
    leader_user = await db.users.find_one({
        "name": req.leader,
        "office_id": hire.get("office_id"),
        "role": {"$in": ["leader", "admin"]},
        "deleted": {"$ne": True},
        "is_active": {"$ne": False},
    })
    if not leader_user:
        raise HTTPException(status_code=400, detail="Coach not found")
    if not admin.get("is_super_admin") and leader_user.get("office_id") != admin.get("office_id"):
        raise HTTPException(status_code=403, detail="The coach must be in your office")
    await db.new_hires.update_one(
        {"id": hire_id},
        {"$set": {"leader": leader_user.get("name", req.leader)}},
    )
    # Also update reports_to on the trainee user to keep tree in sync
    if hire and hire.get("trainee_user_id"):
        await db.users.update_one(
            {"_id": ObjectId(hire["trainee_user_id"])},
            {"$set": {"reports_to": str(leader_user["_id"])}}
        )
    return {"message": "Coach reassigned"}

# ==================== ASSESSMENT ROUTES ====================

def _assessment_out(a: dict) -> dict:
    """Strict-model dump plus the feedback-loop extras DailyAssessment doesn't
    carry: leader pass-off state and the trainee's own acknowledgement."""
    out = DailyAssessment(**a).dict()
    out["passed_off"] = bool(a.get("passed_off"))
    out["acknowledged"] = bool(a.get("acknowledged"))
    out["acknowledged_at"] = a.get("acknowledged_at")
    return out

@router.get("/assessments/{hire_id}")
async def get_assessments(hire_id: str, request: Request):
    user = await get_current_user(request)
    if not await can_access_hire(user, hire_id):
        raise HTTPException(status_code=403, detail="You don't have access to this BA's assessments")
    return [_assessment_out(a) for a in await db.daily_assessments.find({"new_hire_id": hire_id}).sort("day_number", 1).to_list(100)]

@router.get("/assessment/{assessment_id}")
async def get_assessment(assessment_id: str, request: Request):
    user = await get_current_user(request)
    a = await db.daily_assessments.find_one({"id": assessment_id})
    if not a:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if not await can_access_hire(user, a["new_hire_id"]):
        raise HTTPException(status_code=403, detail="You don't have access to this assessment")
    out = _assessment_out(a)
    # Yesterday's "focus for tomorrow" — so the grader opens day N seeing what
    # the trainee was told to work on, plus whether they read that feedback.
    out["prev_day_focus"] = None
    out["prev_day_acknowledged"] = None
    day = int(a.get("day_number") or 1)
    if day > 1:
        prev = await db.daily_assessments.find_one(
            {"new_hire_id": a["new_hire_id"], "day_number": day - 1},
            {"_id": 0, "focus_tomorrow": 1, "completed": 1, "acknowledged": 1, "passed_off": 1},
        )
        if prev and prev.get("completed"):
            out["prev_day_focus"] = prev.get("focus_tomorrow") or None
            out["prev_day_acknowledged"] = bool(prev.get("acknowledged") or prev.get("passed_off"))
    return out

@router.put("/assessment/{assessment_id}")
async def update_assessment(assessment_id: str, update: DailyAssessmentUpdate, request: Request):
    user = await get_current_user(request)
    if user.get("role") == "trainee":
        raise HTTPException(status_code=403, detail="New BAs cannot update assessments")
    assessment = await db.daily_assessments.find_one({"id": assessment_id})
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if not await can_access_hire(user, assessment["new_hire_id"]):
        raise HTTPException(status_code=403, detail="You don't have access to update this assessment")
    update_dict = {k: v for k, v in update.dict().items() if v is not None}
    merged = {**assessment, **update_dict}
    targets_doc = await db.targets.find_one({"day_number": assessment["day_number"]}, {"_id": 0})
    if not targets_doc:
        targets_doc = next((t for t in DAY_TARGETS if t["day_number"] == assessment["day_number"]), None)
    scores = calculate_scores(merged, targets_doc)
    merged.update(scores)
    grade_score = await calculate_checklist_grade(assessment_id)
    merged["checklist_grade_score"] = grade_score
    if update.completed:
        merged["assessment_date"] = datetime.now(timezone.utc).isoformat()
    # MongoDB's immutable primary key may be present on the fetched document;
    # never include it in a $set payload.
    merged.pop("_id", None)
    await db.daily_assessments.update_one({"id": assessment_id}, {"$set": merged})
    if merged.get("completed"):
        try:
            achievement_hire = await db.new_hires.find_one({"id": assessment["new_hire_id"]})
            achievement_user_id = (achievement_hire or {}).get("trainee_user_id")
            if achievement_user_id:
                await award_stage1_milestones(
                    assessment["new_hire_id"], achievement_user_id
                )
        except Exception as e:
            logger.error(f"stage1 achievement award error: {e}")
    if update.completed:
        all_a = await db.daily_assessments.find({"new_hire_id": assessment["new_hire_id"]}).to_list(10)
        completed_days = [a["day_number"] for a in all_a if a.get("completed")]
        next_day = max(completed_days) + 1 if completed_days else 1
        if next_day <= 8:
            await db.new_hires.update_one({"id": assessment["new_hire_id"]}, {"$set": {"current_day": next_day, "current_status": scores["status"]}})
        else:
            await db.new_hires.update_one({"id": assessment["new_hire_id"]}, {"$set": {"current_day": 8, "current_status": "Awaiting Outcome"}})
        # Push to trainee that their assessment was completed (only on the completion transition)
        was_completed = assessment.get("completed") is True
        if not was_completed:
            hire_doc = None
            trainee_user_id = None
            try:
                hire_doc = await db.new_hires.find_one({"id": assessment["new_hire_id"]})
                trainee_user_id = (hire_doc or {}).get("trainee_user_id")
                if trainee_user_id:
                    day_num = assessment.get("day_number", "")
                    await send_push_to_user(
                        trainee_user_id,
                        f"Day {day_num} assessment is ready!",
                        "Tap to view your scores.",
                        {"type": "assessment_complete", "day_number": day_num, "assessment_id": assessment_id},
                    )
            except Exception as e:
                logger.error(f"assessment push error: {e}")

    return {"message": "Assessment updated", "scores": {**scores, "checklist_grade_score": grade_score}}

# ==================== OFFICE HELPERS ====================



# ==================== TARGETS ROUTES ====================

@router.get("/targets")
async def get_targets(request: Request, office: Optional[str] = None):
    user = await get_current_user(request)
    oid = await resolve_office_id(request, user, office)
    items = await db.targets.find({"office_id": oid}, {"_id": 0}).sort("day_number", 1).to_list(10)
    if not items:
        items = await db.targets.find({}, {"_id": 0}).sort("day_number", 1).to_list(10)
    return items if items else DAY_TARGETS

@router.get("/targets/{day_number}")
async def get_day_target(day_number: int, request: Request, office: Optional[str] = None):
    user = await get_current_user(request)
    oid = await resolve_office_id(request, user, office)
    t = await db.targets.find_one({"day_number": day_number, "office_id": oid}, {"_id": 0})
    if not t:
        t = next((t for t in DAY_TARGETS if t["day_number"] == day_number), None)
    if not t:
        raise HTTPException(status_code=404, detail="Day target not found")
    return t

@router.put("/targets/{day_number}")
async def update_day_target(day_number: int, update: TargetUpdate, request: Request, office: Optional[str] = None, apply_all: bool = False):
    user = await require_admin(request)
    user = await get_current_user(request)
    update_dict = {k: v for k, v in update.dict().items() if v is not None}
    if not update_dict:
        return {"message": "Nothing to update"}
    if apply_all and user.get("is_super_admin"):
        offices = await db.offices.find({}).to_list(100)
        for o in offices:
            existing = await db.targets.find_one({"day_number": day_number, "office_id": o["id"]})
            if not existing:
                default = next((t for t in DAY_TARGETS if t["day_number"] == day_number), None)
                if default:
                    new_doc = dict(default)
                    new_doc["office_id"] = o["id"]
                    await db.targets.insert_one(new_doc)
            await db.targets.update_one({"day_number": day_number, "office_id": o["id"]}, {"$set": update_dict})
        return {"message": f"Day {day_number} targets updated for all offices"}
    else:
        oid = await resolve_office_id(request, user, office)
        existing = await db.targets.find_one({"day_number": day_number, "office_id": oid})
        if not existing:
            default = next((t for t in DAY_TARGETS if t["day_number"] == day_number), None)
            if default:
                new_doc = dict(default)
                new_doc["office_id"] = oid
                await db.targets.insert_one(new_doc)
        await db.targets.update_one({"day_number": day_number, "office_id": oid}, {"$set": update_dict})
        return {"message": f"Day {day_number} targets updated"}

# ==================== MANUAL ROUTES ====================

@router.get("/training-manual")
async def get_training_manual(request: Request, office: Optional[str] = None):
    user = await get_current_user(request)
    oid = await resolve_office_id(request, user, office)
    items = await db.training_manual.find({"office_id": oid}, {"_id": 0}).sort([("day_number", 1), ("sequence", 1)]).to_list(500)
    if not items:
        items = await db.training_manual.find({}, {"_id": 0}).sort([("day_number", 1), ("sequence", 1)]).to_list(500)
    return items if items else TRAINING_MANUAL

@router.get("/training-manual/{day_number}")
async def get_training_manual_day(day_number: int, request: Request, office: Optional[str] = None):
    user = await get_current_user(request)
    oid = await resolve_office_id(request, user, office)
    items = await db.training_manual.find({"day_number": day_number, "office_id": oid}, {"_id": 0}).sort("sequence", 1).to_list(100)
    if not items:
        items = [m for m in TRAINING_MANUAL if m["day_number"] == day_number]
    return items

@router.put("/training-manual/{day_number}/reorder")
async def reorder_manual_items(day_number: int, req: ReorderRequest, request: Request, office: Optional[str] = None, apply_all: bool = False):
    user = await require_admin(request)
    user = await get_current_user(request)
    if apply_all and user.get("is_super_admin"):
        offices = await db.offices.find({}).to_list(100)
        for o in offices:
            items = await db.training_manual.find({"day_number": day_number, "office_id": o["id"]}).sort("sequence", 1).to_list(100)
            old_items = {item["sequence"]: item for item in items}
            for new_seq, old_seq in enumerate(req.ordered_sequences, 1):
                if old_seq in old_items:
                    await db.training_manual.update_one({"day_number": day_number, "sequence": old_seq, "office_id": o["id"]}, {"$set": {"sequence": new_seq + 1000}})
            for new_seq, old_seq in enumerate(req.ordered_sequences, 1):
                await db.training_manual.update_one({"day_number": day_number, "sequence": old_seq + 1000 if old_seq in old_items else old_seq, "office_id": o["id"]}, {"$set": {"sequence": new_seq}})
        return {"message": "Items reordered for all offices"}
    else:
        oid = await resolve_office_id(request, user, office)
        items = await db.training_manual.find({"day_number": day_number, "office_id": oid}).sort("sequence", 1).to_list(100)
        old_items = {item["sequence"]: item for item in items}
        for new_seq, old_seq in enumerate(req.ordered_sequences, 1):
            if old_seq in old_items:
                await db.training_manual.update_one({"day_number": day_number, "sequence": old_seq, "office_id": oid}, {"$set": {"sequence": new_seq + 1000}})
        for new_seq, old_seq in enumerate(req.ordered_sequences, 1):
            await db.training_manual.update_one({"day_number": day_number, "sequence": old_seq + 1000 if old_seq in old_items else old_seq, "office_id": oid}, {"$set": {"sequence": new_seq}})
        return {"message": "Items reordered"}

@router.get("/grade-presets")
async def get_grade_presets(request: Request):
    await get_current_user(request)
    return GRADE_PRESETS

@router.get("/settings")
async def get_settings(request: Request, office: Optional[str] = None):
    user = await get_current_user(request)
    oid = await resolve_office_id(request, user, office)
    settings = await db.settings.find_one({"office_id": oid}, {"_id": 0})
    if not settings:
        settings = await db.settings.find_one({"key": "app_settings"}, {"_id": 0})
    return settings or {"pay_tab_visible": True}

@router.put("/settings")
async def update_settings(request: Request, office: Optional[str] = None, apply_all: bool = False):
    user = await require_admin(request)
    user = await get_current_user(request)
    body = await request.json()
    if apply_all and user.get("is_super_admin"):
        offices = await db.offices.find({}).to_list(100)
        for o in offices:
            await db.settings.update_one({"office_id": o["id"]}, {"$set": {**body, "office_id": o["id"]}}, upsert=True)
        return {"message": "Settings updated for all offices"}
    else:
        oid = await resolve_office_id(request, user, office)
        await db.settings.update_one({"office_id": oid}, {"$set": {**body, "office_id": oid}}, upsert=True)
        return {"message": "Settings updated"}

@router.get("/commission-fees")
async def get_commission_fees(request: Request, office: Optional[str] = None):
    """The office's Vertex pay knobs (core/vertex_pay.py): sign-up fees by
    tier, the 3rd DD bonus, the leadership rule and the quality-payment rule.
    Falls back to any office's doc, then to the defaults; an old-shape doc
    (the previous nested pay model) yields the defaults for every knob it
    lacks. `office_name` rides along for the editor's heading."""
    user = await get_current_user(request)
    oid = await resolve_office_id(request, user, office)
    fees = await db.commission_fees.find_one({"office_id": oid}, {"_id": 0})
    if not fees:
        fees = await db.commission_fees.find_one({}, {"_id": 0})
    office_doc = await db.offices.find_one({"id": oid}, {"_id": 0, "name": 1}) if oid else None
    knobs = normalize_fees(fees)
    if user.get("role") != "admin":
        # The office's own income per sign-up is not a BA's or a Coach's figure.
        for key in ADMIN_ONLY_FEE_KEYS:
            knobs.pop(key, None)
    return {
        **knobs,
        "office_name": (office_doc or {}).get("name") or "",
    }

@router.put("/commission-fees")
async def update_commission_fees(request: Request, office: Optional[str] = None, apply_all: bool = False):
    """Save the office's Vertex pay knobs. Only known knobs are stored (a
    Fees-editor round-trip's derived `office_name` and any legacy keys are
    dropped); an out-of-range value is a 400 naming the knob."""
    user = await require_admin(request)
    user = await get_current_user(request)
    body = await request.json()
    try:
        fees = clean_fee_update(body)
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex))
    if not fees:
        raise HTTPException(status_code=400, detail="Nothing to save")
    if apply_all and user.get("is_super_admin"):
        offices = await db.offices.find({}).to_list(100)
        for o in offices:
            await db.commission_fees.update_one({"office_id": o["id"]}, {"$set": {**fees, "office_id": o["id"]}}, upsert=True)
        return {"message": "Pay rates updated for all offices", "fees": normalize_fees(fees)}
    else:
        oid = await resolve_office_id(request, user, office)
        await db.commission_fees.update_one({"office_id": oid}, {"$set": {**fees, "office_id": oid}}, upsert=True)
        saved = await db.commission_fees.find_one({"office_id": oid}, {"_id": 0})
        return {"message": "Pay rates updated", "fees": normalize_fees(saved)}

@router.put("/training-manual/bulk-grade-update")
async def bulk_update_grade_options(req: BulkGradeUpdate, request: Request, office: Optional[str] = None, apply_all: bool = False):
    user = await require_admin(request)
    user = await get_current_user(request)
    if apply_all and user.get("is_super_admin"):
        offices = await db.offices.find({}).to_list(100)
        count = 0
        for o in offices:
            for item in req.items:
                result = await db.training_manual.update_one({"day_number": item["day_number"], "sequence": item["sequence"], "office_id": o["id"]}, {"$set": {"grade_options": item["grade_options"]}})
                if result.modified_count > 0:
                    count += 1
                    mid = f"D{item['day_number']}-{item['sequence']:02d}"
                    await db.delivery_checklist.update_many({"manual_item_id": mid}, {"$set": {"grade_options": item["grade_options"]}})
                    await db.delivery_checklist.update_many({"manual_item_id": mid, "grade": {"$nin": item["grade_options"] + [None]}}, {"$set": {"grade": None}})
        return {"message": f"Updated {count} items across all offices", "updated": count}
    else:
        oid = await resolve_office_id(request, user, office)
        count = 0
        for item in req.items:
            result = await db.training_manual.update_one({"day_number": item["day_number"], "sequence": item["sequence"], "office_id": oid}, {"$set": {"grade_options": item["grade_options"]}})
            if result.modified_count > 0:
                count += 1
                mid = f"D{item['day_number']}-{item['sequence']:02d}"
                # Office-scoped propagation: an admin editing THIS office's
                # grade options must not rewrite another office's in-flight
                # checklists. Rows are stamped with office_id at creation;
                # the None arm keeps legacy unstamped rows updatable until
                # the startup backfill (core/content_fixes) stamps them.
                cl_filter = {"manual_item_id": mid, "office_id": {"$in": [oid, None]}}
                await db.delivery_checklist.update_many(cl_filter, {"$set": {"grade_options": item["grade_options"]}})
                await db.delivery_checklist.update_many({**cl_filter, "grade": {"$nin": item["grade_options"] + [None]}}, {"$set": {"grade": None}})
        return {"message": f"Updated {count} items", "updated": count}

@router.put("/training-manual/{day_number}/{sequence}")
async def update_manual_item(day_number: int, sequence: int, update: ManualItemUpdate, request: Request, office: Optional[str] = None, apply_all: bool = False):
    user = await require_admin(request)
    user = await get_current_user(request)
    update_dict = {k: v for k, v in update.dict().items() if v is not None}
    if not update_dict:
        return {"message": "Nothing to update"}
    if apply_all and user.get("is_super_admin"):
        offices = await db.offices.find({}).to_list(100)
        for o in offices:
            await db.training_manual.update_one({"day_number": day_number, "sequence": sequence, "office_id": o["id"]}, {"$set": update_dict})
        if "grade_options" in update_dict:
            mid = f"D{day_number}-{sequence:02d}"
            await db.delivery_checklist.update_many({"manual_item_id": mid}, {"$set": {"grade_options": update_dict["grade_options"]}})
            await db.delivery_checklist.update_many({"manual_item_id": mid, "grade": {"$nin": update_dict["grade_options"] + [None]}}, {"$set": {"grade": None}})
        return {"message": "Manual item updated for all offices"}
    else:
        oid = await resolve_office_id(request, user, office)
        result = await db.training_manual.update_one({"day_number": day_number, "sequence": sequence, "office_id": oid}, {"$set": update_dict})
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Manual item not found")
        if "grade_options" in update_dict:
            mid = f"D{day_number}-{sequence:02d}"
            # office_id ∈ {oid, None}: stamped rows for this office plus
            # legacy unstamped rows (backfilled at startup by content_fixes).
            # The old exact-match on office_id matched ZERO rows because
            # checklist rows historically carried no office_id at all.
            await db.delivery_checklist.update_many({"manual_item_id": mid, "office_id": {"$in": [oid, None]}}, {"$set": {"grade_options": update_dict["grade_options"]}})
        return {"message": "Manual item updated"}

@router.post("/training-manual/add")
async def add_manual_item(item: ManualItemCreateBody, request: Request, office: Optional[str] = None, apply_all: bool = False):
    user = await require_admin(request)
    user = await get_current_user(request)
    confidence = (item.confidence_expected or "").strip() or "Understand"
    if apply_all and user.get("is_super_admin"):
        offices = await db.offices.find({}).to_list(100)
        for o in offices:
            existing = await db.training_manual.find({"day_number": item.day_number, "office_id": o["id"]}).sort("sequence", -1).to_list(1)
            next_seq = (existing[0]["sequence"] + 1) if existing else 1
            new_item = {"day_number": item.day_number, "sequence": next_seq, "category": item.category, "topic": item.topic, "what_good_looks_like": item.what_good_looks_like, "expected_outcome": item.expected_outcome, "confidence_expected": confidence, "required": True, "grade_options": item.grade_options or ["Excellent", "Average", "Below Average"], "office_id": o["id"]}
            await db.training_manual.insert_one(new_item)
        return {"message": "Item added to all offices"}
    else:
        oid = await resolve_office_id(request, user, office)
        existing = await db.training_manual.find({"day_number": item.day_number, "office_id": oid}).sort("sequence", -1).to_list(1)
        next_seq = (existing[0]["sequence"] + 1) if existing else 1
        new_item = {"day_number": item.day_number, "sequence": next_seq, "category": item.category, "topic": item.topic, "what_good_looks_like": item.what_good_looks_like, "expected_outcome": item.expected_outcome, "confidence_expected": confidence, "required": True, "grade_options": item.grade_options or ["Excellent", "Average", "Below Average"], "office_id": oid}
        await db.training_manual.insert_one(new_item)
        return {"message": "Item added", "sequence": next_seq}

@router.delete("/training-manual/{day_number}/{sequence}")
async def delete_manual_item(day_number: int, sequence: int, request: Request, office: Optional[str] = None, apply_all: bool = False):
    user = await require_admin(request)
    user = await get_current_user(request)
    if apply_all and user.get("is_super_admin"):
        offices = await db.offices.find({}).to_list(100)
        for o in offices:
            await db.training_manual.delete_one({"day_number": day_number, "sequence": sequence, "office_id": o["id"]})
        return {"message": "Manual item deleted from all offices"}
    else:
        oid = await resolve_office_id(request, user, office)
        result = await db.training_manual.delete_one({"day_number": day_number, "sequence": sequence, "office_id": oid})
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Manual item not found")
        return {"message": "Manual item deleted"}

# ==================== CHECKLIST ROUTES ====================

@router.get("/checklist/{assessment_id}", response_model=List[DeliveryChecklist])
async def get_checklist(assessment_id: str, request: Request):
    user = await get_current_user(request)
    assessment = await db.daily_assessments.find_one({"id": assessment_id})
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if not await can_access_hire(user, assessment["new_hire_id"]):
        raise HTTPException(status_code=403, detail="You don't have access to this checklist")
    items = await db.delivery_checklist.find({"assessment_id": assessment_id}).to_list(100)
    # Enrich each item with the latest "what_good_looks_like" + "expected_outcome"
    # from the training_manual so the trainee/leader assessment screen can
    # show inline coaching content when the topic is tapped. We pull manuals
    # for the assessment's day_number (single round-trip) and join in memory.
    if assessment and items:
        # Find the office that owns this assessment via the new_hire record.
        hire = await db.new_hires.find_one(
            {"id": assessment.get("new_hire_id")}, {"office_id": 1}
        )
        office_id = (hire or {}).get("office_id")
        day_no = int(assessment.get("day_number") or 0)
        manuals = await db.training_manual.find(
            {"day_number": day_no, "office_id": office_id}
        ).to_list(200)
        # Fall back to the global template if this office has none seeded
        if not manuals:
            manuals = await db.training_manual.find(
                {"day_number": day_no, "office_id": None}
            ).to_list(200)
        # Build {f"D{day}-{seq:02d}": manual_doc} lookup
        manual_by_id = {f"D{day_no}-{m.get('sequence', 0):02d}": m for m in manuals}
        for it in items:
            mid = it.get("manual_item_id")
            m = manual_by_id.get(mid)
            if m:
                # Only attach if non-empty so frontend can guard the
                # tap-to-expand panel cleanly.
                w = m.get("what_good_looks_like") or None
                e = m.get("expected_outcome") or None
                if w:
                    it["what_good_looks_like"] = w
                if e:
                    it["expected_outcome"] = e
    return [DeliveryChecklist(**i) for i in items]

@router.put("/checklist/{item_id}")
async def update_checklist_item(item_id: str, update: DeliveryChecklistUpdate, request: Request):
    user = await get_current_user(request)
    if user.get("role") == "trainee":
        raise HTTPException(status_code=403, detail="New BAs cannot update checklists")
    item_doc = await db.delivery_checklist.find_one({"id": item_id})
    if not item_doc:
        raise HTTPException(status_code=404, detail="Checklist item not found")
    assessment = await db.daily_assessments.find_one({"id": item_doc["assessment_id"]})
    if not assessment:
        raise HTTPException(status_code=409, detail="Checklist item is not linked to an assessment")
    if not await can_access_hire(user, assessment["new_hire_id"]):
        raise HTTPException(status_code=403, detail="You don't have access to update this checklist")
    update_dict = {k: v for k, v in update.dict().items() if v is not None}
    result = await db.delivery_checklist.update_one({"id": item_id}, {"$set": update_dict})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Checklist item not found")
    item = await db.delivery_checklist.find_one({"id": item_id})
    if item:
        gs = await calculate_checklist_grade(item["assessment_id"])
        await db.daily_assessments.update_one({"id": item["assessment_id"]}, {"$set": {"checklist_grade_score": gs}})
    return {"message": "Checklist item updated"}

# ==================== DASHBOARD ROUTES ====================

@router.get("/dashboard/stats")
async def get_dashboard_stats(request: Request, office: Optional[str] = None):
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    match: dict = {"active": True}
    if user["role"] == "leader":
        subtree_ids = await get_subtree_ids(user["id"])
        trainee_users = await db.users.find(
            {"_id": {"$in": [ObjectId(sid) for sid in subtree_ids]}, "role": "trainee", "is_active": {"$ne": False}},
            {"new_hire_id": 1}
        ).to_list(500)
        hire_ids = [u["new_hire_id"] for u in trainee_users if u.get("new_hire_id")]
        leader_names = []
        for sid in subtree_ids:
            u = await db.users.find_one({"_id": ObjectId(sid)}, {"name": 1, "role": 1})
            if u and u.get("role") in ("leader", "admin"):
                leader_names.append(u.get("name", ""))
        leader_names.append(user.get("name", ""))
        match["$or"] = coach_hire_filter(hire_ids, list(subtree_ids) + [user["id"]], leader_names)
    if user.get("is_super_admin") and office:
        match["office_id"] = await resolve_office_id(request, user, office)
    elif not user.get("is_super_admin"):
        if not user.get("office_id"):
            raise HTTPException(status_code=403, detail="Your account is not assigned to an office")
        match["office_id"] = user["office_id"]
    # Exclude ghost records for soft-deleted users so the pulse count and
    # status chips match the live users list (parity with /new-hires).
    deleted_q: dict = {"deleted": True}
    if not user.get("is_super_admin") and user.get("office_id"):
        deleted_q["office_id"] = user["office_id"]
    deleted_raw = await db.users.find(deleted_q, {"name": 1, "new_hire_id": 1, "_id": 1}).to_list(1000)
    del_names = [u["name"] for u in deleted_raw if u.get("name")]
    del_hire_ids = [u["new_hire_id"] for u in deleted_raw if u.get("new_hire_id")]
    del_user_ids = [str(u["_id"]) for u in deleted_raw]
    if del_names:
        match["name"] = {"$nin": del_names}
    if del_hire_ids:
        match["id"] = {"$nin": del_hire_ids}
    if del_user_ids:
        match["trainee_user_id"] = {"$nin": del_user_ids}
    total = await db.new_hires.count_documents(match)
    statuses = {s["_id"]: s["count"] for s in await db.new_hires.aggregate([{"$match": match}, {"$group": {"_id": "$current_status", "count": {"$sum": 1}}}]).to_list(100)}
    outcome_match: dict = {"final_outcome": {"$ne": None}}
    if user["role"] == "leader":
        if "$or" in match:
            outcome_match["$or"] = match["$or"]
        else:
            outcome_match["leader"] = user.get("name", "")
    if match.get("office_id"):
        outcome_match["office_id"] = match["office_id"]
    outcomes = {o["_id"]: o["count"] for o in await db.new_hires.aggregate([{"$match": outcome_match}, {"$group": {"_id": "$final_outcome", "count": {"$sum": 1}}}]).to_list(100)}
    hire_ids_list = [h["id"] for h in await db.new_hires.find(match, {"id": 1}).to_list(1000)]
    # Always include the scoped id filter.  Omitting it for an empty team made
    # the averages silently become country-wide.
    avg_match: dict = {"completed": True, "new_hire_id": {"$in": hire_ids_list}}
    day_avgs = {d["_id"]: round(d["avg_score"], 2) if d["avg_score"] else 0 for d in await db.daily_assessments.aggregate([{"$match": avg_match}, {"$group": {"_id": "$day_number", "avg_score": {"$avg": "$overall_score"}}}]).to_list(100)}
    return {"total_active_hires": total, "status_breakdown": statuses, "outcome_breakdown": outcomes, "average_score_by_day": day_avgs}

@router.get("/leaders")
async def get_leaders(request: Request):
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    query: dict = {"active": True}
    if user.get("role") == "leader":
        subtree_ids = set(await get_subtree_ids(user["id"]))
        subtree_ids.add(user["id"])
        object_ids = []
        for uid in subtree_ids:
            try:
                object_ids.append(ObjectId(uid))
            except Exception:
                continue
        rows = await db.users.find(
            {
                "_id": {"$in": object_ids},
                "role": {"$in": ["leader", "admin"]},
                "deleted": {"$ne": True},
                "is_active": {"$ne": False},
            },
            {"name": 1},
        ).to_list(500)
        return sorted({r.get("name") for r in rows if r.get("name")})
    if not user.get("is_super_admin"):
        if not user.get("office_id"):
            raise HTTPException(status_code=403, detail="Your account is not assigned to an office")
        query["office_id"] = user["office_id"]
    return await db.new_hires.distinct("leader", query)

@router.get("/admin/unassigned-hires")
async def get_unassigned_hires(request: Request):
    """Admin-only: returns active new hires with no leader assigned.
    Used to let admins access Day 1-2 orientation assessments before
    a field leader is allocated on Day 3."""
    user = await get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    query: dict = {
        "active": True,
        "$or": [{"leader": None}, {"leader": ""}, {"leader": {"$exists": False}}],
    }
    if not user.get("is_super_admin"):
        if not user.get("office_id"):
            raise HTTPException(status_code=403, detail="Your account is not assigned to an office")
        query["office_id"] = user["office_id"]
    hires = await db.new_hires.find(query, {"_id": 0}).sort("start_date", -1).to_list(500)
    return {"hires": [
        {
            "hire_id": h["id"],
            "name": h.get("name", ""),
            "start_date": h.get("start_date"),
            "campaign": h.get("campaign", ""),
            "current_day": h.get("current_day", 1),
        }
        for h in hires
    ]}


@router.get("/available-leaders")
async def get_available_leaders(request: Request):
    """Authenticated endpoint: returns list of leaders/admins for selection dropdowns.
    Used by admins/leaders when assigning or reassigning hires."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    query: dict = {
        "role": {"$in": ["leader", "admin"]},
        "is_active": {"$ne": False},
        "deleted": {"$ne": True},
        "is_demo": {"$ne": True},
    }
    if user.get("role") == "leader":
        allowed = await get_subtree_ids(user["id"])
        query["_id"] = {"$in": [ObjectId(uid) for uid in allowed]}
    elif not user.get("is_super_admin"):
        if not user.get("office_id"):
            return []
        query["office_id"] = user["office_id"]
    leaders = await db.users.find(
        query,
        {"password_hash": 0}
    ).to_list(200)
    result = []
    for l in leaders:
        result.append({
            "id": str(l["_id"]),
            "name": l.get("name", ""),
            "role": l.get("role", ""),
            "office_id": l.get("office_id"),
        })
    result.sort(key=lambda x: x["name"])
    return result

@router.post("/admin/sync-hierarchy")
async def sync_hierarchy(request: Request):
    """Repair all reports_to / new_hires.leader mismatches AND migrate untagged content to offices."""
    await require_super_admin(request)
    fixed = 0
    # 0. Auto-migrate untagged content to offices
    offices = await db.offices.find({}).to_list(100)
    if offices:
        first_office_id = offices[0]["id"]
        for coll_name in ['training_manual', 'targets', 'commission_fees', 'settings']:
            coll = db[coll_name]
            result = await coll.update_many({"office_id": {"$exists": False}}, {"$set": {"office_id": first_office_id}})
            if result.modified_count > 0:
                logger.info(f"Tagged {result.modified_count} {coll_name} docs as {offices[0].get('name', first_office_id)}")
                fixed += result.modified_count
                # Clone to other offices if they don't have data
                for other_office in offices[1:]:
                    count = await coll.count_documents({"office_id": other_office["id"]})
                    if count == 0:
                        docs = await coll.find({"office_id": first_office_id}).to_list(500)
                        if docs:
                            clones = [{k: v for k, v in d.items() if k != '_id'} for d in docs]
                            for c in clones:
                                c['office_id'] = other_office["id"]
                            await coll.insert_many(clones)
                            fixed += len(clones)
                            logger.info(f"Cloned {len(clones)} {coll_name} docs for {other_office.get('name', other_office['id'])}")
    # 1. For every hire with a trainee_user_id, ensure reports_to is set
    hires = await db.new_hires.find({}).to_list(1000)
    for hire in hires:
        trainee_uid = hire.get("trainee_user_id")
        leader_name = hire.get("leader", "")
        if trainee_uid and leader_name:
            leader_user = await db.users.find_one({"name": leader_name, "role": {"$in": ["leader", "admin"]}})
            if leader_user:
                trainee = await db.users.find_one({"_id": ObjectId(trainee_uid)})
                if trainee and trainee.get("reports_to") != str(leader_user["_id"]):
                    await db.users.update_one(
                        {"_id": ObjectId(trainee_uid)},
                        {"$set": {"reports_to": str(leader_user["_id"])}}
                    )
                    fixed += 1
    # 2. For every user with reports_to, ensure their hire's leader matches
    users_with_reports = await db.users.find({"reports_to": {"$ne": None}}).to_list(1000)
    for u in users_with_reports:
        parent = await db.users.find_one({"_id": ObjectId(u["reports_to"])})
        if parent:
            parent_name = parent.get("name", "")
            hire_id = u.get("new_hire_id")
            if hire_id:
                hire = await db.new_hires.find_one({"id": hire_id})
                if hire and hire.get("leader") != parent_name:
                    await db.new_hires.update_one({"id": hire_id}, {"$set": {"leader": parent_name}})
                    fixed += 1
            # Also check by trainee_user_id
            uid = str(u["_id"])
            result = await db.new_hires.update_many(
                {"trainee_user_id": uid, "leader": {"$ne": parent_name}},
                {"$set": {"leader": parent_name}}
            )
            fixed += result.modified_count
    return {"message": f"Synced hierarchy. {fixed} records fixed."}

# ==================== HIERARCHY ROUTES ====================

async def build_tree_node(user_doc: dict) -> dict:
    uid = str(user_doc["_id"])
    role = user_doc.get("role", "")
    node = {
        "id": uid, "name": user_doc.get("name", ""), "email": user_doc.get("email", ""),
        "phone": (user_doc.get("phone") or "").strip(),
        "role": role, "profile_image": user_doc.get("profile_image"),
        "office_id": user_doc.get("office_id"), "team_name": user_doc.get("team_name") or None,
        "is_super_admin": bool(user_doc.get("is_super_admin")),
        "owneriq_stage": user_doc.get("owneriq_stage"), "children": [],
    }
    # ── Stage-progress preview for the tree row badge ──────────────────────
    # Trainee: how many Day 1-8 assessments are PASSED OFF, then if Stage 2
    # is unlocked, how many Stage 2 modules they've completed.
    # Leader/Admin: how many Stage 3 modules they've completed (target=self).
    if role == "trainee":
        hire = await db.new_hires.find_one({"trainee_user_id": uid}, {"_id": 0})
        # Defaults — trainees without a hire record still get stage-1 0/8.
        node["current_stage"] = 1
        node["current_stage_completed"] = 0
        node["current_stage_total"] = 8
        if hire:
            node["current_day"] = hire.get("current_day", 1)
            node["current_status"] = hire.get("current_status", "Pending")
            node["hire_id"] = hire.get("id")
            # Trainees often have their number only on the hire record
            # (set at application time) — fall back to it for tap-to-call.
            if not node["phone"]:
                node["phone"] = (hire.get("phone") or "").strip()
            try:
                # Stage 1 progress is now driven by COMPLETED days (formal
                # pass-off no longer required as a gating signal).
                completed = await db.daily_assessments.distinct(
                    "day_number",
                    {"new_hire_id": hire.get("id"), "completed": True},
                )
                pcount = sum(1 for d in (completed or []) if 1 <= d <= 8)
            except Exception:
                pcount = 0
            if pcount >= 8:
                # Stage 1 complete — surface Stage 2 progress instead
                try:
                    s2_total_doc = await db.training_modules.count_documents({"stage": 2, "office_id": user_doc.get("office_id")})
                    if not s2_total_doc:
                        s2_total_doc = await db.training_modules.count_documents({"stage": 2, "office_id": None})
                    s2_completed = await db.module_progress.count_documents({
                        "stage": 2, "target_user_id": uid, "completed": True,
                    })
                except Exception:
                    s2_total_doc, s2_completed = 0, 0
                node["current_stage"] = 2
                node["current_stage_completed"] = s2_completed
                node["current_stage_total"] = s2_total_doc
            else:
                node["current_stage_completed"] = pcount
                # current_stage_total stays 8 from defaults
    elif role in ("leader", "admin"):
        # Stage 3 module progress for self
        try:
            s3_total = await db.training_modules.count_documents({"stage": 3, "office_id": user_doc.get("office_id")})
            if not s3_total:
                s3_total = await db.training_modules.count_documents({"stage": 3, "office_id": None})
            s3_completed = await db.module_progress.count_documents({
                "stage": 3, "target_user_id": uid, "completed": True,
            })
        except Exception:
            s3_total, s3_completed = 0, 0
        node["current_stage"] = 3
        node["current_stage_completed"] = s3_completed
        node["current_stage_total"] = s3_total
    children = await db.users.find({"reports_to": uid, "deleted": {"$ne": True}, "is_active": {"$ne": False}, "is_demo": {"$ne": True}}).sort("name", 1).to_list(500)
    for child in children:
        child_node = await build_tree_node(child)
        node["children"].append(child_node)
    return node

def _prune_tree_to_office(node: dict, office_id: str) -> bool:
    """Keep only branches that contain at least one member of `office_id`.
    Mutates node.children in place; returns True if this node or any
    descendant belongs to the office (so the caller keeps it). The root is
    always retained by the caller regardless of its own office."""
    kept_children = []
    for child in node.get("children", []):
        if _prune_tree_to_office(child, office_id):
            kept_children.append(child)
    node["children"] = kept_children
    return node.get("office_id") == office_id or bool(kept_children)


@router.get("/team/tree")
async def get_team_tree(request: Request, office: Optional[str] = None):
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    viewer_doc = await db.users.find_one({"_id": ObjectId(user["id"])})
    if not viewer_doc:
        raise HTTPException(status_code=404, detail="User not found")

    # Which node the tree is rooted at. A super admin viewing a FOREIGN office
    # (e.g. the owner looking at another office) sees it from that office's own admin's
    # point of view — rooted at that admin, showing their downline — rather than
    # their own downline (which would read as "I'm the leader there"). Their
    # home office still roots at themselves.
    root_doc = viewer_doc
    selected_office = None
    if user.get("is_super_admin") and office:
        selected_office = await resolve_office_id(request, user, office)
    elif not user.get("is_super_admin"):
        if not user.get("office_id"):
            raise HTTPException(status_code=403, detail="Your account is not assigned to an office")
        selected_office = user["office_id"]
    if selected_office and user.get("is_super_admin") and selected_office != viewer_doc.get("office_id"):
        office_admin = await db.users.find_one({
            "office_id": selected_office, "role": "admin",
            "is_active": {"$ne": False}, "deleted": {"$ne": True},
            # Never root a foreign-office tree at a walk-around demo admin.
            "is_demo": {"$ne": True},
        })
        if office_admin:
            root_doc = office_admin

    tree = await build_tree_node(root_doc)
    # The tree is derived exclusively from stable reports_to links. Legacy
    # name caches are repaired by the explicit super-admin sync endpoint; a
    # GET must not guess identity from a non-unique display name.
    # Super-admin office switch: prune the downline to the selected office so
    # the Team/Spider views stay office-clean (the root is always kept).
    if selected_office:
        _prune_tree_to_office(tree, selected_office)
    return tree

@router.put("/admin/users/{user_id}/reports-to")
async def set_reports_to(user_id: str, request: Request):
    admin = await require_admin(request)
    body = await request.json()
    parent_id = (body.get("reports_to") or "").strip() or None
    try:
        target_oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user id")
    target_user_before = await db.users.find_one({
        "_id": target_oid,
        "deleted": {"$ne": True},
        "is_active": {"$ne": False},
    })
    if not target_user_before:
        raise HTTPException(status_code=404, detail="User not found")
    if (
        not admin.get("is_super_admin")
        and target_user_before.get("office_id") != admin.get("office_id")
    ):
        raise HTTPException(status_code=403, detail="You can only edit accounts in your own office")

    parent = None
    if parent_id:
        if parent_id == user_id:
            raise HTTPException(status_code=400, detail="A user cannot report to themselves")
        try:
            parent = await db.users.find_one({
                "_id": ObjectId(parent_id),
                "role": {"$in": ["leader", "admin"]},
                "deleted": {"$ne": True},
                "is_active": {"$ne": False},
            })
        except Exception:
            parent = None
        if not parent:
            raise HTTPException(status_code=400, detail="That coach was not found")
        if (
            not admin.get("is_super_admin")
            and parent.get("office_id") != admin.get("office_id")
        ):
            raise HTTPException(status_code=403, detail="The coach must be in your office")
        subtree = await get_subtree_ids(user_id)
        if parent_id in subtree:
            raise HTTPException(status_code=400, detail="Cannot create circular hierarchy")
    # Capture previous parent for change-detection
    prev_parent_id = target_user_before.get("reports_to") if target_user_before else None
    if parent_id:
        await db.users.update_one({"_id": target_oid}, {"$set": {"reports_to": parent_id}})
    else:
        await db.users.update_one({"_id": target_oid}, {"$unset": {"reports_to": ""}})
    # OwnerIQ — mirror the reparent in the family tree (move under the leader).
    # Fire-and-forget; gated by OWNERIQ_WRITES_ENABLED (no-op until enabled).
    if parent_id:
        try:
            import asyncio as _aio
            from owneriq_write import hook_leader_assignment
            _aio.create_task(hook_leader_assignment(user_id, parent_id))
        except Exception as _e:
            logger.warning(f"OwnerIQ reparent hook skipped: {_e}")
    # Sync: update new_hires.leader for ANY user that has a hire record (trainee or promoted leader)
    target_user = await db.users.find_one({"_id": ObjectId(user_id)})
    if target_user:
        parent_name = parent.get("name", "") if parent_id and parent else "Unassigned"
        # Update new_hires.leader if user has a hire record.  Clearing the
        # hierarchy must also clear the denormalized leader cache or the old
        # name-based compatibility fallback can keep granting access.
        hire_id = target_user.get("new_hire_id")
        if hire_id:
            await db.new_hires.update_one({"id": hire_id}, {"$set": {"leader": parent_name}})
        await db.new_hires.update_many(
            {"trainee_user_id": user_id, "office_id": target_user.get("office_id")},
            {"$set": {"leader": parent_name}},
        )
    # Notify new leader only when parent actually changed and new parent exists
    if parent_id and parent_id != prev_parent_id and parent and target_user:
        try:
            send_new_hire_email(
                leader_name=parent.get("name", ""),
                leader_email=parent.get("email", ""),
                hire_name=target_user.get("name", ""),
                hire_email=target_user.get("email", ""),
            )
        except Exception as e:
            logger.error(f"new hire email error: {e}")
        try:
            await send_push_to_user(
                parent_id,
                "New team member",
                f"{target_user.get('name', 'A new BA')} has been added to your team",
                {"type": "new_hire", "hire_user_id": user_id},
            )
        except Exception as e:
            logger.error(f"new hire push error: {e}")
    # Achievements: the new parent is now (or already was) someone's leader;
    # if the person being re-parented is themselves a leader, everyone up the
    # new chain now "has a leader on their team".
    if parent_id:
        try:
            await award(parent_id, "team_builder")
            if (target_user or {}).get("role") in ("leader", "admin"):
                await award_upline_core_leader(user_id)
        except Exception as e:
            logger.error(f"hierarchy achievement error: {e}")
    return {"message": "Hierarchy updated"}

# ==================== APP SETUP ====================
