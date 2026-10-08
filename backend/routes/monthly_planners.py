"""Monthly Goal Planner — per-user monthly self-assessment + planning.

Mirrors the printed "Monthly Goal Planner" the office fills out. Stored one document per (user, month).

Collection: monthly_planners
Document shape:
  {
    id: uuid,
    user_id, office_id, month: "YYYY-MM",
    locked: bool,                # true once a newer month exists for this user
    goals: {
      short_business, short_personal,
      medium_business, medium_personal,
      long_business, long_personal
    },
    monthly_planning: {
      sales_impacts: { coach_others: str, still_to_master: str },
      development:  [ { id, topic, who, when, completed } ],
      recruitment:  [ { id, topic, who, when, completed } ],
      networking:   [ { id, topic, who, when, completed } ]
    },
    learning: { summary: str, items: [ { id, topic, mentor, notes } ] },
    budget: {
      needs:  [ { id, label, amount, sales } ],
      wants:  [ { id, label, amount, sales } ],
      sale_value, total_money_needs, total_sales_needs,
      total_money_wants, total_sales_wants, total_sales_required
    },
    swot: { strengths, weaknesses, opportunities, threats },
    gap_analysis: { scores: { trait_key: 1..5 } },     # leader/admin only
    created_at, updated_at
  }

Permission rules:
- The owner can read+write their own months (only the most-recent month is
  editable; older months auto-lock when a newer one is created).
- A "leader" can READ the months of any user whose `reports_to` chain
  eventually points to that leader (transitive sub-tree).
- An admin can READ every planner in their office.
- A super-admin can READ everything.
- Trainees DO NOT have a Gap Analysis (filtered out at fetch time).
"""
import os
import uuid
from datetime import datetime, timezone, date
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from bson import ObjectId
from dotenv import load_dotenv

from auth import get_current_user, require_admin

load_dotenv()

router = APIRouter()
from database import db  # the shared client; one DB_NAME default (database.py)


# ── Goal model (v2) ─────────────────────────────────────────────────────────
# v2 goals are STRUCTURED: KPIs (numbers/measurables) + Rocks (did-I/didn't-I
# tasks), each with a horizon and an attached reward — this is what the guided
# Goal Builder writes. Legacy planners stored six free-text strings; those docs
# are detected by the ABSENCE of a version/kpis key and rendered read-only by
# the client. New/edited planners always write v2.
GOAL_VERSION = 2
_HORIZONS = ("short", "medium", "long")
_MAX_GOAL_ROWS = 8

# Legacy free-text keys — kept only so an un-migrated editable doc isn't wiped
# if its owner saves before the builder converts it.
LEGACY_GOAL_KEYS = (
    "short_business", "short_personal",
    "medium_business", "medium_personal",
    "long_business", "long_personal",
)


def _default_goals() -> dict:
    """Fresh empty v2 goals block (own list instances — never share refs)."""
    return {"version": GOAL_VERSION, "kpis": [], "rocks": [], "vision": ""}


def _norm_horizon(v) -> str:
    v = (str(v or "")).strip().lower()
    return v if v in _HORIZONS else "short"


def _normalize_goals(raw) -> dict:
    """Normalize the goals payload. A payload carrying kpis/rocks/version is
    v2 (structured); anything else is treated as the legacy 6-field shape and
    passed through so an un-migrated editable doc isn't blanked."""
    raw = raw or {}
    is_v2 = (raw.get("kpis") is not None) or (raw.get("rocks") is not None) or bool(raw.get("version"))
    if not is_v2:
        return {k: (str(raw.get(k) or "")).strip() for k in LEGACY_GOAL_KEYS}

    def _kpi(r: dict) -> dict:
        return {
            "id": (r.get("id") or str(uuid.uuid4())),
            "name": (str(r.get("name") or "")).strip(),
            "target": (str(r.get("target") or "")).strip(),
            "horizon": _norm_horizon(r.get("horizon")),
            "reward": (str(r.get("reward") or "")).strip(),
            "smart_ok": bool(r.get("smart_ok")),
        }

    def _rock(r: dict) -> dict:
        return {
            "id": (r.get("id") or str(uuid.uuid4())),
            "name": (str(r.get("name") or "")).strip(),
            "horizon": _norm_horizon(r.get("horizon")),
            "reward": (str(r.get("reward") or "")).strip(),
            "done": bool(r.get("done")),
        }

    kpis = [_kpi(r) for r in (raw.get("kpis") or []) if isinstance(r, dict)][:_MAX_GOAL_ROWS]
    rocks = [_rock(r) for r in (raw.get("rocks") or []) if isinstance(r, dict)][:_MAX_GOAL_ROWS]
    return {"version": GOAL_VERSION, "kpis": kpis, "rocks": rocks, "vision": (str(raw.get("vision") or "")).strip()}


# ── Goal Builder menu (KPI presets + Rock suggestions) ──────────────────────
# Admin-editable per office (planner_goal_menu collection, mirrors the
# onboarding-content pattern). These are the built-in fallbacks — the exact
# lists from the org's goal-setting session.
DEFAULT_KPI_MENU: list = [
    "Sign-ups (personal)",
    "Contract sign-ups",
    "Team sign-ups",
    "Contract piece average",
    "Team size",
    "Stage 3 count",
    "2nd-week retention %",
    "4th-week retention %",
    "Welcome Calls completed %",
    "£15+ %",
    "First-day-ons taken out",
    "First-day coachings done",
    "New stars booked in",
    "ERs booked for Initial Appointment",
    "Initial Appointments run",
    "New starters",
    "Personal best",
]

DEFAULT_ROCK_SUGGESTIONS: list = [
    "Visit another office",
    "Finish reading a book",
    "Gym 3 out of 7 days",
    "Run 2 team meetings",
    "Run an Initial Appointment",
    "Set up 2 conference calls",
    "Run a sector for a day",
    "Advance a stage",
    "Run the office for 2 days",
]

DEFAULT_SWOT: dict = {
    "strengths": "",
    "weaknesses": "",
    "opportunities": "",
    "threats": "",
}

# Default budget rows seeded into a NEW planner. Users can edit/add/remove.
DEFAULT_NEEDS_LABELS = ["Phone", "Food", "Insurance", "Travel", "Rent"]
DEFAULT_WANTS_LABELS = ["Savings"]

# 16 leadership traits (Leader Gap Analysis radar). Score 1..5 each.
GAP_TRAITS: list = [
    "Adaptability",
    "Mind-set / Focus",
    "Professional Image",
    "Relentlessness",
    "Doing Extra 10%",
    "Networking",
    "Setting Development Goals",
    "Hitting Sales Targets",
    "Accepting Criticism",
    "Proactive Learner",
    "Solution-orientated",
    "Proactive Helper",
    "Planned Impacts",
    "Time-management",
    "Customer Service",
    "Coaching New People",
]


def _empty_budget_row(label: str = "") -> dict:
    return {"id": str(uuid.uuid4()), "label": label, "amount": "", "sales": ""}


def _empty_planning_row() -> dict:
    return {"id": str(uuid.uuid4()), "topic": "", "who": "", "when": "", "completed": False}


def _empty_learning_item() -> dict:
    return {"id": str(uuid.uuid4()), "topic": "", "mentor": "", "notes": ""}


def _seed_planner(user_id: str, office_id: str, month: str, role: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    gap_scores = {t: 0 for t in GAP_TRAITS} if role in ("leader", "admin") else {}
    return {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "office_id": office_id,
        "month": month,
        "locked": False,
        "goals": _default_goals(),
        "monthly_planning": {
            "sales_impacts": {"coach_others": "", "still_to_master": ""},
            "development": [_empty_planning_row() for _ in range(4)],
            "recruitment": [_empty_planning_row() for _ in range(4)],
            "networking": [_empty_planning_row() for _ in range(4)],
        },
        "learning": {"summary": "", "items": [_empty_learning_item() for _ in range(3)]},
        "budget": {
            "needs": [_empty_budget_row(lbl) for lbl in DEFAULT_NEEDS_LABELS],
            "wants": [_empty_budget_row(lbl) for lbl in DEFAULT_WANTS_LABELS],
            "sale_value": "",
            "total_money_needs": 0,
            "total_sales_needs": 0,
            "total_money_wants": 0,
            "total_sales_wants": 0,
            "total_sales_required": 0,
        },
        "swot": dict(DEFAULT_SWOT),
        "gap_analysis": {"scores": gap_scores},
        "targets": {"monthly_sales": 0, "personal_best": 0},
        "created_at": now,
        "updated_at": now,
    }


def _coerce_month(s: str) -> Optional[str]:
    if not s:
        return None
    s = s.strip()
    # Accept "YYYY-MM" or "YYYY-MM-DD"
    if len(s) == 7:
        try:
            y, m = s.split("-")
            int(y); mi = int(m)
            if 1 <= mi <= 12:
                return f"{int(y):04d}-{mi:02d}"
        except Exception:
            return None
    try:
        d = date.fromisoformat(s)
        return d.strftime("%Y-%m")
    except Exception:
        return None


def _scrub(doc: Optional[dict]) -> Optional[dict]:
    if not doc:
        return None
    if "_id" in doc:
        doc.pop("_id", None)
    return doc


async def _resolve_target_user(request: Request, target_user_id: Optional[str]) -> tuple[dict, dict]:
    """Resolve who the planner is FOR (target) given the requesting user.
    Returns (requesting_user_doc, target_user_doc). Permission-checks that
    the requester may read the target's planners.
    """
    me = await get_current_user(request)
    if not target_user_id or target_user_id == me["id"]:
        return me, me

    try:
        target = await db.users.find_one({"_id": ObjectId(target_user_id)})
    except Exception:
        target = None
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    target = {**target, "id": str(target["_id"])}
    target.pop("_id", None)

    if me.get("is_super_admin"):
        return me, target
    if me.get("role") == "admin" and (target.get("office_id") or "") == (me.get("office_id") or ""):
        return me, target

    # Leader: allow if target is somewhere in the leader's reports tree
    if me.get("role") == "leader":
        cur = target
        for _ in range(20):  # depth-cap
            parent_id = cur.get("reports_to")
            if not parent_id:
                break
            if str(parent_id) == me["id"]:
                return me, target
            try:
                cur = await db.users.find_one({"_id": ObjectId(parent_id)})
            except Exception:
                cur = None
            if not cur:
                break
            cur = {**cur, "id": str(cur["_id"])}

    raise HTTPException(status_code=403, detail="Not authorised to view that user's planner")


def _strip_for_role(doc: dict, target_role: str) -> dict:
    """Trainees do NOT have Gap Analysis. Strip it from the response so the
    UI can hide the section."""
    if target_role == "trainee":
        doc["gap_analysis"] = {"scores": {}}
    return doc


# ── ENDPOINTS ──────────────────────────────────────────────────────────────


@router.get("/monthly-planners/traits")
async def list_traits(request: Request):
    """Return the 16 Gap-Analysis traits — used by the radar chart UI."""
    await get_current_user(request)
    return {"traits": GAP_TRAITS}


# NOTE: goal-menu routes are declared BEFORE "/monthly-planners/{month}" so the
# single-segment path isn't captured as a month (same reason /traits sits here).
@router.get("/monthly-planners/goal-menu")
async def get_goal_menu(request: Request):
    """KPI presets + Rock suggestions for the guided Goal Builder. An office
    doc overrides the global doc, which falls back to the built-in defaults —
    so the builder always has a list even before an admin customises anything.
    Any authed user may read; only admins may edit."""
    me = await get_current_user(request)
    office_id = me.get("office_id")

    global_doc = await db.planner_goal_menu.find_one({"office_id": None}, {"_id": 0})
    office_doc = None
    if office_id:
        office_doc = await db.planner_goal_menu.find_one({"office_id": office_id}, {"_id": 0})

    def _pick(field: str, default: list) -> list:
        for d in (office_doc, global_doc):
            if d and d.get(field) is not None:
                return d.get(field)
        return default

    kpis = [str(x).strip() for x in _pick("kpis", DEFAULT_KPI_MENU) if str(x).strip()]
    rocks = [str(x).strip() for x in _pick("rock_suggestions", DEFAULT_ROCK_SUGGESTIONS) if str(x).strip()]
    return {
        "kpis": kpis,
        "rock_suggestions": rocks,
        "can_edit": (me.get("role") == "admin") or bool(me.get("is_super_admin")),
    }


@router.put("/monthly-planners/goal-menu")
async def put_goal_menu(request: Request):
    """Admin only. Upsert this admin's office menu (or the global menu when the
    admin has no office set). Body: { kpis: [str], rock_suggestions: [str] }."""
    admin = await require_admin(request)
    office_id = admin.get("office_id") or None
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}

    def _clean_list(v, cap: int = 40) -> list:
        out = []
        if isinstance(v, list):
            for x in v:
                s = str(x or "").strip()
                if s:
                    out.append(s)
        return out[:cap]

    update: dict = {"updated_at": datetime.now(timezone.utc).isoformat(), "updated_by": admin.get("id")}
    if "kpis" in body:
        update["kpis"] = _clean_list(body.get("kpis"))
    if "rock_suggestions" in body:
        update["rock_suggestions"] = _clean_list(body.get("rock_suggestions"))
    if "kpis" not in update and "rock_suggestions" not in update:
        raise HTTPException(status_code=400, detail="Nothing to update")

    await db.planner_goal_menu.update_one(
        {"office_id": office_id},
        {"$set": update, "$setOnInsert": {"office_id": office_id}},
        upsert=True,
    )
    saved = await db.planner_goal_menu.find_one({"office_id": office_id}, {"_id": 0}) or {}
    return {
        "kpis": saved.get("kpis") or [],
        "rock_suggestions": saved.get("rock_suggestions") or [],
        "office_id": office_id,
    }


@router.get("/monthly-planners")
async def list_my_planners(request: Request, user_id: Optional[str] = None):
    """List all planner months for the current user (or a specified user the
    requester is allowed to view). Returns sparse summaries (no large
    sub-fields), newest month first."""
    me, target = await _resolve_target_user(request, user_id)
    cursor = db.monthly_planners.find(
        {"user_id": target["id"]},
        {"_id": 0, "id": 1, "month": 1, "locked": 1, "updated_at": 1},
    ).sort("month", -1)
    items = await cursor.to_list(120)
    return {
        "user": {"id": target["id"], "name": target.get("name") or target.get("email"), "role": target.get("role")},
        "items": items,
    }


@router.get("/monthly-planners/{month}")
async def get_planner(month: str, request: Request, user_id: Optional[str] = None):
    """Get the planner doc for a specific month. Auto-creates an EMPTY
    placeholder if none exists yet AND the requester is the owner. Other
    viewers (leaders/admins) get 404 if not yet created."""
    coerced = _coerce_month(month)
    if not coerced:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    me, target = await _resolve_target_user(request, user_id)

    doc = await db.monthly_planners.find_one(
        {"user_id": target["id"], "month": coerced},
        {"_id": 0},
    )
    if not doc:
        if target["id"] != me["id"]:
            raise HTTPException(status_code=404, detail=f"No planner exists for {coerced}")
        # Owner viewing their own non-existent month — return seed + flag
        seed = _seed_planner(me["id"], me.get("office_id") or "", coerced, me.get("role") or "trainee")
        return {
            "exists": False,
            "can_edit": True,
            "viewer_is_owner": True,
            "target_role": me.get("role"),
            "planner": _strip_for_role(seed, me.get("role") or "trainee"),
        }

    # Existing planner. Compute can_edit:
    # - Only the OWNER may edit
    # - And only when the planner is NOT locked
    can_edit = (target["id"] == me["id"]) and not bool(doc.get("locked"))
    return {
        "exists": True,
        "can_edit": can_edit,
        "viewer_is_owner": (target["id"] == me["id"]),
        "target_role": target.get("role"),
        "planner": _strip_for_role(doc, target.get("role") or "trainee"),
    }


def _normalize_planning_rows(raw: list) -> list:
    out = []
    if isinstance(raw, list):
        for r in raw:
            if not isinstance(r, dict):
                continue
            out.append({
                "id": (r.get("id") or str(uuid.uuid4())),
                "topic": (r.get("topic") or "").strip(),
                "who": (r.get("who") or "").strip(),
                "when": (r.get("when") or "").strip(),
                "completed": bool(r.get("completed")),
            })
    return out


def _normalize_budget_rows(raw: list) -> list:
    out = []
    if isinstance(raw, list):
        for r in raw:
            if not isinstance(r, dict):
                continue
            out.append({
                "id": (r.get("id") or str(uuid.uuid4())),
                "label": (r.get("label") or "").strip(),
                "amount": (str(r.get("amount") or "")).strip(),
                "sales": (str(r.get("sales") or "")).strip(),
            })
    return out


def _safe_num(x) -> float:
    try:
        s = str(x or "").replace(",", "").replace("$", "").strip()
        if not s:
            return 0.0
        return float(s)
    except Exception:
        return 0.0


def _compute_budget_totals(b: dict) -> dict:
    needs = b.get("needs") or []
    wants = b.get("wants") or []
    tm_n = sum(_safe_num(r.get("amount")) for r in needs)
    ts_n = sum(_safe_num(r.get("sales")) for r in needs)
    tm_w = sum(_safe_num(r.get("amount")) for r in wants)
    ts_w = sum(_safe_num(r.get("sales")) for r in wants)
    sale_v = _safe_num(b.get("sale_value"))
    if sale_v > 0:
        # Recompute sales-required from money totals if sale_value is set
        derived = round((tm_n + tm_w) / sale_v) if sale_v else 0
    else:
        derived = ts_n + ts_w
    b["total_money_needs"] = round(tm_n, 2)
    b["total_sales_needs"] = round(ts_n, 2)
    b["total_money_wants"] = round(tm_w, 2)
    b["total_sales_wants"] = round(ts_w, 2)
    b["total_sales_required"] = derived
    return b


@router.put("/monthly-planners/{month}")
async def upsert_planner(month: str, request: Request):
    """Owner only. Creates or updates the planner for the given month. When
    a NEWER month exists in the same user's history the older months are
    locked from edits — so this endpoint is the only path to first-time
    creating a month, but only for the latest unlocked month.

    On creation of a brand-new month, this endpoint also LOCKS every prior
    month for that user (they become permanently read-only)."""
    coerced = _coerce_month(month)
    if not coerced:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    me = await get_current_user(request)
    user_id = me["id"]

    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}

    # ── Normalize incoming body ───────────────────────────────────────────
    goals = _normalize_goals(body.get("goals"))

    swot_in = body.get("swot") or {}
    swot = {k: (str(swot_in.get(k) or "")).strip() for k in DEFAULT_SWOT.keys()}

    mp_in = body.get("monthly_planning") or {}
    si_in = (mp_in.get("sales_impacts") or {})
    monthly_planning = {
        "sales_impacts": {
            "coach_others": (str(si_in.get("coach_others") or "")).strip(),
            "still_to_master": (str(si_in.get("still_to_master") or "")).strip(),
        },
        "development": _normalize_planning_rows(mp_in.get("development")),
        "recruitment": _normalize_planning_rows(mp_in.get("recruitment")),
        "networking": _normalize_planning_rows(mp_in.get("networking")),
    }

    learning_in = body.get("learning") or {}
    learning_items_in = learning_in.get("items") or []
    learning = {
        "summary": (str(learning_in.get("summary") or "")).strip(),
        "items": [
            {
                "id": (r.get("id") or str(uuid.uuid4())),
                "topic": (str(r.get("topic") or "")).strip(),
                "mentor": (str(r.get("mentor") or "")).strip(),
                "notes": (str(r.get("notes") or "")).strip(),
            }
            for r in learning_items_in
            if isinstance(r, dict)
        ],
    }

    budget_in = body.get("budget") or {}
    budget = {
        "needs": _normalize_budget_rows(budget_in.get("needs")),
        "wants": _normalize_budget_rows(budget_in.get("wants")),
        "sale_value": (str(budget_in.get("sale_value") or "")).strip(),
    }
    budget = _compute_budget_totals(budget)

    gap_in = (body.get("gap_analysis") or {}).get("scores") or {}
    gap_scores: dict = {}
    if me.get("role") in ("leader", "admin"):
        for t in GAP_TRAITS:
            v = gap_in.get(t)
            try:
                n = int(v) if v not in (None, "") else 0
            except Exception:
                n = 0
            gap_scores[t] = max(0, min(5, n))

    # Targets — both are optional positive integers; 0/blank = unset
    def _int_or_zero(v):
        try:
            n = int(v) if v not in (None, "") else 0
        except Exception:
            n = 0
        return max(0, n)
    targets_in = body.get("targets") or {}
    targets = {
        "monthly_sales": _int_or_zero(targets_in.get("monthly_sales")),
        "personal_best": _int_or_zero(targets_in.get("personal_best")),
    }

    now = datetime.now(timezone.utc).isoformat()

    # ── Lookup existing ────────────────────────────────────────────────────
    existing = await db.monthly_planners.find_one(
        {"user_id": user_id, "month": coerced},
        {"_id": 0},
    )

    # If trying to edit a locked older month, refuse.
    if existing and bool(existing.get("locked")):
        raise HTTPException(status_code=403, detail="This month is locked. Open the latest month to edit.")

    # If creating a NEW month, ensure no future month already exists (you
    # can't edit a past month once a future one was created).
    if not existing:
        future = await db.monthly_planners.find_one(
            {"user_id": user_id, "month": {"$gt": coerced}},
            {"_id": 0, "month": 1},
            sort=[("month", -1)],
        )
        if future:
            raise HTTPException(
                status_code=403,
                detail=f"A newer month ({future.get('month')}) already exists. New months can only be created at or after the latest one.",
            )

    if existing:
        update = {
            "goals": goals,
            "swot": swot,
            "monthly_planning": monthly_planning,
            "learning": learning,
            "budget": budget,
            "targets": targets,
            "updated_at": now,
        }
        if me.get("role") in ("leader", "admin"):
            update["gap_analysis"] = {"scores": gap_scores}
        await db.monthly_planners.update_one({"id": existing["id"]}, {"$set": update})
        existing.update(update)
        return {"ok": True, "planner": _strip_for_role(existing, me.get("role") or "trainee")}

    # Brand-new month — first lock all earlier months for this user
    await db.monthly_planners.update_many(
        {"user_id": user_id, "month": {"$lt": coerced}},
        {"$set": {"locked": True}},
    )

    doc = _seed_planner(user_id, me.get("office_id") or "", coerced, me.get("role") or "trainee")
    doc.update({
        "goals": goals,
        "swot": swot,
        "monthly_planning": monthly_planning,
        "learning": learning,
        "budget": budget,
        "targets": targets,
        "updated_at": now,
    })
    if me.get("role") in ("leader", "admin"):
        doc["gap_analysis"] = {"scores": gap_scores}
    await db.monthly_planners.insert_one(doc.copy())
    return {"ok": True, "planner": _strip_for_role(doc, me.get("role") or "trainee")}


@router.post("/monthly-planners/start/{month}")
async def start_new_month(month: str, request: Request):
    """Create a fresh planner for `month`, AUTOFILLING from the user's most
    recent existing planner (SWOT inherits, GAP scores inherit, budget
    structure inherits, planning rows reset to empty). Locks all prior
    months in the process. Owner only."""
    coerced = _coerce_month(month)
    if not coerced:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    me = await get_current_user(request)
    user_id = me["id"]
    role = me.get("role") or "trainee"

    # Already exists?
    existing = await db.monthly_planners.find_one(
        {"user_id": user_id, "month": coerced},
        {"_id": 0},
    )
    if existing:
        return {"ok": True, "created": False, "planner": _strip_for_role(existing, role)}

    # Most recent prior planner (for inheritance)
    prev = await db.monthly_planners.find_one(
        {"user_id": user_id, "month": {"$lt": coerced}},
        {"_id": 0},
        sort=[("month", -1)],
    )

    seed = _seed_planner(user_id, me.get("office_id") or "", coerced, role)
    if prev:
        # SWOT is intentionally NOT inherited — leaders should reflect on
        # their CURRENT month's strengths/weaknesses each month from scratch.
        # Inherit gap scores for leaders/admins
        if role in ("leader", "admin"):
            prev_scores = (prev.get("gap_analysis") or {}).get("scores") or {}
            scores = {t: int(prev_scores.get(t) or 0) for t in GAP_TRAITS}
            seed["gap_analysis"] = {"scores": scores}
        # Inherit budget rows + sale_value (numbers stay; user adjusts)
        prev_budget = prev.get("budget") or {}
        seed["budget"]["needs"] = _normalize_budget_rows(prev_budget.get("needs")) or seed["budget"]["needs"]
        seed["budget"]["wants"] = _normalize_budget_rows(prev_budget.get("wants")) or seed["budget"]["wants"]
        seed["budget"]["sale_value"] = (str(prev_budget.get("sale_value") or "")).strip()
        seed["budget"] = _compute_budget_totals(seed["budget"])
        # Carry goals forward as scaffolding (user can rewrite). v2 keeps the
        # KPI/Rock names + targets but resets each Rock's done flag; a legacy
        # prev doc → fresh v2 (the guided builder rebuilds from scratch).
        prev_goals = prev.get("goals") or {}
        if (prev_goals.get("kpis") is not None) or bool(prev_goals.get("version")):
            carried = _normalize_goals(prev_goals)
            for r in carried.get("rocks", []):
                r["done"] = False
            seed["goals"] = carried
        else:
            seed["goals"] = _default_goals()

    # Lock all earlier months
    await db.monthly_planners.update_many(
        {"user_id": user_id, "month": {"$lt": coerced}},
        {"$set": {"locked": True}},
    )

    await db.monthly_planners.insert_one(seed.copy())
    return {"ok": True, "created": True, "planner": _strip_for_role(seed, role)}


@router.get("/monthly-planners/team/roster")
async def team_roster(request: Request):
    """For leaders + admins. Returns a list of users this requester is
    allowed to view planners for, with each user's most-recent month."""
    me = await get_current_user(request)
    role = me.get("role")
    if role not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")

    if role == "admin":
        # Whole office (super-admin sees their own office; we don't expose
        # cross-office views from this endpoint to keep blast-radius small).
        office_id = me.get("office_id") or ""
        cursor = db.users.find({"office_id": office_id, "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}}, {"_id": 1, "name": 1, "email": 1, "role": 1})
    else:
        # Leader → transitive reports tree
        seen = {me["id"]}
        roots = [me["id"]]
        depth = 0
        while roots and depth < 8:
            children = await db.users.find(
                {"reports_to": {"$in": roots}, "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}},
                {"_id": 1, "name": 1, "email": 1, "role": 1},
            ).to_list(500)
            child_ids = [str(c["_id"]) for c in children]
            new_ids = [cid for cid in child_ids if cid not in seen]
            if not new_ids:
                break
            seen.update(new_ids)
            roots = new_ids
            depth += 1
        if not seen:
            return {"items": []}
        seen.discard(me["id"])
        if not seen:
            return {"items": []}
        try:
            obj_ids = [ObjectId(s) for s in seen]
        except Exception:
            obj_ids = []
        cursor = db.users.find({"_id": {"$in": obj_ids}, "is_active": {"$ne": False}, "deleted": {"$ne": True}}, {"_id": 1, "name": 1, "email": 1, "role": 1})

    users = await cursor.to_list(500)
    items: list = []
    for u in users:
        uid = str(u["_id"])
        latest = await db.monthly_planners.find_one(
            {"user_id": uid},
            {"_id": 0, "month": 1, "updated_at": 1},
            sort=[("month", -1)],
        )
        items.append({
            "id": uid,
            "name": u.get("name") or u.get("email"),
            "role": u.get("role"),
            "latest_month": (latest or {}).get("month"),
            "updated_at": (latest or {}).get("updated_at"),
        })
    items.sort(key=lambda x: ((0 if x.get("role") == "leader" else 1), (x.get("name") or "").lower()))
    return {"items": items}



@router.get("/monthly-planners/{month}/sales-actual")
async def planner_sales_actual(month: str, request: Request):
    """Compute the user's actual bells-recorded sales for the given month.
    Sums (over30 + under30) across every day in every bells_entry where
    week_ending falls within the calendar month and the day's status is 'in'
    (excludes off/ab/nc). Used by the monthly planner to show progress
    against the user's monthly_sales_target."""
    coerced = _coerce_month(month)
    if not coerced:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    me = await get_current_user(request)
    user_id = me["id"]

    # Compute month start/end (YYYY-MM-DD bounds inclusive)
    y, m = (int(p) for p in coerced.split("-"))
    next_y, next_m = (y + 1, 1) if m == 12 else (y, m + 1)
    month_start = f"{y:04d}-{m:02d}-01"
    next_month_start = f"{next_y:04d}-{next_m:02d}-01"

    # Each bells_entry has a week_ending (Sunday, YYYY-MM-DD). A week's days
    # span Mon-Sun, where day index 0 = Mon-of-(week_ending - 6 days) and day
    # index 6 = week_ending itself. We just iterate every entry and check each
    # day's actual date against the month bounds.
    from datetime import datetime as _dt, timedelta as _td

    cursor = db.bells_entries.find({"user_id": user_id}, {"_id": 0, "week_ending": 1, "days": 1})
    total = 0
    over30_total = 0
    under30_total = 0
    days_worked = 0
    async for e in cursor:
        we = e.get("week_ending") or ""
        try:
            we_dt = _dt.strptime(we, "%Y-%m-%d")
        except Exception:
            continue
        # Quick skip: if the entire week is before month-start or on/after next-month-start, skip
        last_day = we_dt
        first_day = we_dt - _td(days=6)
        if last_day.strftime("%Y-%m-%d") < month_start or first_day.strftime("%Y-%m-%d") >= next_month_start:
            continue
        days = e.get("days") or []
        for i in range(min(7, len(days))):
            d = days[i] or {}
            day_date = (we_dt - _td(days=(6 - i))).strftime("%Y-%m-%d")
            if day_date < month_start or day_date >= next_month_start:
                continue
            if (d.get("status") or "off") != "in":
                continue
            o = int(d.get("over30") or 0)
            u = int(d.get("under30") or 0)
            sales = o + u
            if sales > 0 or d.get("status") == "in":
                total += sales
                over30_total += o
                under30_total += u
                if sales > 0:
                    days_worked += 1

    return {
        "month": coerced,
        "total_sales": total,
        "over30": over30_total,
        "under30": under30_total,
        "days_worked": days_worked,
    }
