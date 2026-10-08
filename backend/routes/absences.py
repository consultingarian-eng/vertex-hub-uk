"""Absence requests — leader-declared crew absences with owner approval.

Flow:
  • A leader marks crew days "Ab" in the Weekly Planner → that no longer
    writes to Bells directly. Instead ONE pending absence request per
    (member, week) is created/updated here (with the leader's reason), and
    every admin of that office gets a push notification.
  • The office admin (owner) approves or denies from the Absence Approvals
    screen. Approval writes the `ab` statuses straight onto the member's
    bells row — the same cells the old direct write touched — so Bells,
    the planner and reports stay one source of truth.
  • The leader sees "requested · awaiting approval" in the planner until
    the decision lands, then gets a push with the outcome.

Admins / super-admins marking absences themselves still write directly
(no self-approval loop) — that path never reaches this module.
"""
import uuid
from datetime import datetime, timezone, date, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from auth import get_current_user, require_admin
from database import db
from core.app_time import uk_date
from core.push import send_push_to_user

router = APIRouter()

DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _days_label(day_indices: list) -> str:
    return ", ".join(DAY_SHORT[i] for i in sorted(set(day_indices)) if 0 <= i <= 5) or "—"


def _week_label(week_ending: str) -> str:
    """'2026-10-04' → '4 Oct' (UK style); unparseable input comes back as-is."""
    return uk_date(week_ending, year=False)


def _scrub(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


async def _notify_office_admins(office_id: str, title: str, body: str, data: dict, exclude_id: str = ""):
    """Push to every active admin of the office (best-effort)."""
    admins = await db.users.find(
        {"role": "admin", "office_id": office_id or "", "is_active": {"$ne": False}, "deleted": {"$ne": True}},
        {"_id": 1},
    ).to_list(50)
    for a in admins:
        uid = str(a["_id"])
        if uid == exclude_id:
            continue
        try:
            await send_push_to_user(uid, title, body, data)
        except Exception:
            pass


async def submit_absence_request(me: dict, target: dict, week_ending: str,
                                 day_indices: list, reason: str) -> Optional[dict]:
    """Create/update the pending request for (target, week). Empty day set
    cancels a pending request. Returns the pending doc (or None). Called
    from the weekly-planner crew endpoint — not exposed as its own route."""
    target_id = str(target["_id"]) if "_id" in target else str(target.get("id"))
    day_indices = sorted({int(i) for i in day_indices if 0 <= int(i) <= 5})
    reason = (reason or "").strip()[:500]
    now = _now_iso()

    pending = await db.absence_requests.find_one(
        {"target_user_id": target_id, "week_ending": week_ending, "status": "pending"}
    )

    if not day_indices:
        if pending:
            await db.absence_requests.update_one(
                {"id": pending["id"]},
                {"$set": {"status": "cancelled", "updated_at": now}},
            )
        return None

    if pending:
        changed = (sorted(pending.get("day_indices") or []) != day_indices
                   or (reason and reason != (pending.get("reason") or "")))
        upd = {"day_indices": day_indices, "updated_at": now,
               "requester_id": me["id"],
               "requester_name": me.get("name") or me.get("email") or ""}
        if reason:
            upd["reason"] = reason
        await db.absence_requests.update_one({"id": pending["id"]}, {"$set": upd})
        pending.update(upd)
        doc = pending
        if not changed:
            return _scrub(doc)
    else:
        doc = {
            "id": str(uuid.uuid4()),
            "office_id": target.get("office_id") or me.get("office_id") or "",
            "week_ending": week_ending,
            "target_user_id": target_id,
            "target_name": target.get("name") or target.get("email") or "",
            "requester_id": me["id"],
            "requester_name": me.get("name") or me.get("email") or "",
            "day_indices": day_indices,
            "reason": reason,
            "status": "pending",
            "decided_by_id": None,
            "decided_by_name": None,
            "decided_at": None,
            "decision_note": "",
            "created_at": now,
            "updated_at": now,
        }
        await db.absence_requests.insert_one(doc.copy())

    body = f"{doc['requester_name']} requests {_days_label(day_indices)} off for {doc['target_name']} (WE {_week_label(week_ending)})"
    if reason:
        body += f" — “{reason}”"
    await _notify_office_admins(
        doc["office_id"],
        "Absence request ⏳",
        body,
        {"type": "absence_request", "url": "/absence-approvals"},
        exclude_id=me["id"],
    )
    return _scrub(doc)


@router.post("/absence-requests")
async def create_absence_request(request: Request):
    """Direct request path used by the Bells screen: a leader taps AB on a
    day → that day is merged into the member's pending request for the week
    (creating one if needed) and the office admins are notified. Same
    approval pipeline as the Weekly Planner's crew step."""
    me = await get_current_user(request)
    if me.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}

    try:
        d = date.fromisoformat((body.get("week_ending") or "").strip())
        week_ending = (d + timedelta(days=(6 - d.weekday()) % 7)).isoformat()
    except Exception:
        raise HTTPException(status_code=400, detail="week_ending must be a valid YYYY-MM-DD date")
    day_indices = [int(i) for i in (body.get("day_indices") or []) if isinstance(i, (int, float)) and 0 <= int(i) <= 5]
    if not day_indices:
        raise HTTPException(status_code=400, detail="day_indices required (0=Mon … 5=Sat)")

    # A reason is mandatory — the owner approves or denies off the back of it,
    # so a blank request isn't actionable. The clients disable Send until this
    # is met; enforce it here too so the rule can't be bypassed.
    if len(str(body.get("reason") or "").strip()) < 3:
        raise HTTPException(status_code=400, detail="A reason is required so the owner can decide.")

    try:
        target = await db.users.find_one({"_id": ObjectId(str(body.get("target_user_id") or ""))})
    except Exception:
        target = None
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    target_id = str(target["_id"])

    allowed = bool(me.get("is_super_admin"))
    if not allowed and me.get("role") == "admin":
        allowed = (target.get("office_id") or "") == (me.get("office_id") or "")
    if not allowed:
        from auth import get_subtree_ids
        subtree = await get_subtree_ids(me["id"])
        allowed = target_id in subtree
    if not allowed:
        raise HTTPException(status_code=403, detail="You can only request absences for people on your own team")

    # Merge with whatever's already pending so a tap-per-day flow never
    # replaces earlier requested days.
    pending = await db.absence_requests.find_one(
        {"target_user_id": target_id, "week_ending": week_ending, "status": "pending"})
    merged = sorted(set((pending or {}).get("day_indices") or []) | set(day_indices))
    doc = await submit_absence_request(me, target, week_ending, merged, body.get("reason") or "")
    return {"ok": True, "request": doc}


@router.get("/absence-requests")
async def list_absence_requests(
    request: Request,
    status: Optional[str] = None,
    week: Optional[str] = None,
    office_id: Optional[str] = None,
):
    """Admins: every request for their office (pending first). Leaders: the
    requests they submitted — powers the planner's 'awaiting approval' UI.

    Approvals are always scoped to ONE office. A super admin picks which via
    `office_id` (falling back to their home office) and switches with the
    office selector; a single-office admin is pinned to their own office and
    cannot widen the scope by passing office_id.
    """
    me = await get_current_user(request)
    role = me.get("role")
    if role not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")

    q: dict = {}
    if role == "admin":
        if me.get("is_super_admin"):
            requested = (office_id or "").strip()
            accessible = me.get("accessible_offices") or []
            if requested:
                if accessible and requested not in accessible:
                    raise HTTPException(status_code=403, detail="You do not have access to that office")
                q["office_id"] = requested
            else:
                q["office_id"] = me.get("office_id") or ""
        else:
            # Pinned to their own office — an office_id param can't widen this.
            q["office_id"] = me.get("office_id") or ""
    else:
        q["requester_id"] = me["id"]
    if status:
        q["status"] = status
    if week:
        q["week_ending"] = week

    docs = await db.absence_requests.find(q, {"_id": 0}).sort("created_at", -1).to_list(200)
    # Pending first; within each group keep the Mongo newest-first order
    # (a stable sort on status alone preserves it).
    docs.sort(key=lambda d: 0 if d.get("status") == "pending" else 1)
    return {"items": docs[:200]}


@router.get("/absence-requests/pending-count")
async def absence_requests_pending_count(request: Request, office_id: Optional[str] = None):
    """Badge for the admin entry point. Scoped to the same single office the
    approvals list shows, so the badge never counts requests the admin can't
    see on the screen it points at."""
    me = await require_admin(request)
    q: dict = {"status": "pending"}
    if me.get("is_super_admin"):
        requested = (office_id or "").strip()
        accessible = me.get("accessible_offices") or []
        if requested and (not accessible or requested in accessible):
            q["office_id"] = requested
        else:
            q["office_id"] = me.get("office_id") or ""
    else:
        q["office_id"] = me.get("office_id") or ""
    n = await db.absence_requests.count_documents(q)
    return {"pending": n}


async def _write_ab_days(target: dict, week_ending: str, day_indices: list, actor: dict):
    """Stamp `ab` on the member's bells row for the approved days — the same
    write the planner used to do directly. Creates the row if missing."""
    from routes.bells import _normalize_days
    target_id = str(target["_id"])
    now = _now_iso()
    # Full bells row key (office included) — matches uniq_office_week_user so
    # this writer always finds the same row every other writer does.
    office_id = target.get("office_id") or ""
    if not office_id:
        raise HTTPException(status_code=400, detail="Office unknown for this member")
    existing = await db.bells_entries.find_one(
        {"office_id": office_id, "user_id": target_id, "week_ending": week_ending}
    )
    days = _normalize_days((existing or {}).get("days"))
    for i in day_indices:
        if 0 <= i <= 5:
            days[i]["status"] = "ab"
    if existing:
        await db.bells_entries.update_one({"id": existing["id"]}, {"$set": {"days": days, "updated_at": now}})
    else:
        try:
            await db.bells_entries.insert_one({
                "id": str(uuid.uuid4()),
                "office_id": office_id,
                "user_id": target_id,
                "user_name": target.get("name") or target.get("email") or "",
                "role": target.get("role"),
                "stage": None,
                "break_even": None,
                "weekly_goal": None,
                "last_week_total": None,
                "week_ending": week_ending,
                "days": days,
                "earnings": 0.0,
                "created_by_id": actor["id"],
                "created_at": now,
                "updated_at": now,
            })
        except DuplicateKeyError:
            # Lost the create race (uniq_office_week_user) — stamp the Ab days
            # onto the winner's row, rebuilt from ITS days so a racing writer's
            # sales are never clobbered by our empty defaults.
            existing = await db.bells_entries.find_one(
                {"office_id": office_id, "user_id": target_id, "week_ending": week_ending}
            )
            if existing:
                days = _normalize_days(existing.get("days"))
                for i in day_indices:
                    if 0 <= i <= 5:
                        days[i]["status"] = "ab"
                await db.bells_entries.update_one(
                    {"id": existing["id"]}, {"$set": {"days": days, "updated_at": now}}
                )


@router.post("/absence-requests/{req_id}/decide")
async def decide_absence_request(req_id: str, request: Request):
    """Approve or deny a pending request. Approval writes the Ab days onto
    the member's Bells row; either way the requesting leader gets a push."""
    me = await require_admin(request)
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    action = str(body.get("action") or "").strip().lower()
    if action not in ("approve", "deny"):
        raise HTTPException(status_code=400, detail="action must be 'approve' or 'deny'")
    note = (str(body.get("note") or "")).strip()[:300]

    doc = await db.absence_requests.find_one({"id": req_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if not me.get("is_super_admin") and (doc.get("office_id") or "") != (me.get("office_id") or ""):
        raise HTTPException(status_code=403, detail="This request belongs to another office")
    if doc.get("status") != "pending":
        raise HTTPException(status_code=409, detail=f"Request already {doc.get('status')}")

    if action == "approve":
        try:
            target = await db.users.find_one({"_id": ObjectId(doc["target_user_id"])})
        except Exception:
            target = None
        if not target:
            raise HTTPException(status_code=404, detail="Member no longer exists")
        await _write_ab_days(target, doc["week_ending"], doc.get("day_indices") or [], me)

    now = _now_iso()
    new_status = "approved" if action == "approve" else "denied"
    await db.absence_requests.update_one({"id": req_id}, {"$set": {
        "status": new_status,
        "decided_by_id": me["id"],
        "decided_by_name": me.get("name") or me.get("email") or "",
        "decided_at": now,
        "decision_note": note,
        "updated_at": now,
    }})

    days_lbl = _days_label(doc.get("day_indices") or [])
    title = "Absence approved ✅" if action == "approve" else "Absence denied ❌"
    body_txt = f"{doc.get('target_name')} — {days_lbl} (WE {_week_label(doc.get('week_ending') or '')})"
    if note:
        body_txt += f" · {note}"
    try:
        await send_push_to_user(doc["requester_id"], title, body_txt,
                                {"type": "absence_decision", "url": "/weekly-planner"})
    except Exception:
        pass

    doc = await db.absence_requests.find_one({"id": req_id}, {"_id": 0})
    return {"ok": True, "request": doc}
