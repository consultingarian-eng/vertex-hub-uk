"""Shareable Training Manual editor — single-page web tool gated by a shared
password (set via MANUAL_EDITOR_PASSWORD env var).

Designed so an admin can paste ONE link into a chat and the recipient can
edit the per-office training manual + assessments without needing a Cube
account. All write operations are auto-saved on blur/change in the UI.

URL: GET /api/manual-editor              — HTML page (no auth — JS gates content)
     POST /api/manual-editor/auth        — verify password (returns ok)
     GET /api/manual-editor/offices      — list offices
     GET /api/manual-editor/manual       — full manual for office_id
     PATCH /api/manual-editor/item       — partial-update one item
     POST /api/manual-editor/item        — add a new item
     DELETE /api/manual-editor/item      — delete one item
     POST /api/manual-editor/reorder     — set new sequence order for a day

Auth model: every protected endpoint requires the `X-Editor-Password`
header; backend compares against MANUAL_EDITOR_PASSWORD env (loaded by
load_dotenv()). Constant-time comparison.
"""
import os
import uuid
import hmac
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict, Any

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException, Request, Body
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database import db
from core.rate_limit import client_ip

load_dotenv()

logger = logging.getLogger(__name__)
router = APIRouter()

ROOT_DIR = Path(__file__).resolve().parent.parent  # /app/backend
EDITOR_HTML_PATH = ROOT_DIR / "static" / "manual_editor.html"

AUTH_WINDOW_SECONDS = 15 * 60
AUTH_MAX_FAILURES = 5
# Every wrong shared password, from any address, counts toward one global cap:
# per-IP limits alone can be spread across many addresses. Once it trips, the
# shared password is refused for the window (signed-in admins still work).
GLOBAL_MAX_FAILURES = 30
MIN_EDITOR_PASSWORD_LENGTH = 16
_auth_failures: Dict[str, List[float]] = {}
_GLOBAL_KEY = "__all__"
_warned_short = False


def _expected_password() -> str:
    # No built-in credential: a missing environment value disables shared-
    # password access. Normal authenticated admins may still use the editor.
    # A short value also disables it: it is one shared secret for every
    # office's training content, so it must not be guessable.
    global _warned_short
    value = (os.getenv("MANUAL_EDITOR_PASSWORD") or "").strip()
    if value and len(value) < MIN_EDITOR_PASSWORD_LENGTH:
        if not _warned_short:
            logger.warning("MANUAL_EDITOR_PASSWORD is shorter than %d characters; "
                           "shared editor access stays disabled", MIN_EDITOR_PASSWORD_LENGTH)
            _warned_short = True
        return ""
    return value


def _auth_key(req: Request) -> str:
    return client_ip(req)


def _recent_failures(key: str) -> List[float]:
    cutoff = time.monotonic() - AUTH_WINDOW_SECONDS
    recent = [t for t in _auth_failures.get(key, []) if t >= cutoff]
    if recent:
        _auth_failures[key] = recent
    else:
        _auth_failures.pop(key, None)
    return recent


def _check_rate_limit(req: Request) -> None:
    if len(_recent_failures(_auth_key(req))) >= AUTH_MAX_FAILURES:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")


def _global_locked() -> bool:
    return len(_recent_failures(_GLOBAL_KEY)) >= GLOBAL_MAX_FAILURES


def _record_failure(req: Request, *, password_tried: bool = False) -> None:
    key = _auth_key(req)
    if len(_auth_failures) >= 5_000 and key not in _auth_failures:
        stalest = min(_auth_failures, key=lambda k: _auth_failures[k][-1] if _auth_failures[k] else 0)
        _auth_failures.pop(stalest, None)
    _auth_failures.setdefault(key, []).append(time.monotonic())
    if password_tried:
        _auth_failures.setdefault(_GLOBAL_KEY, []).append(time.monotonic())


def _clear_failures(req: Request) -> None:
    _auth_failures.pop(_auth_key(req), None)


async def _check_auth(req: Request) -> dict:
    """Auth gate for editor endpoints.

    Accepts EITHER:
      • `X-Editor-Password` header matching MANUAL_EDITOR_PASSWORD, OR
      • A valid admin login (cookie-based or Bearer token) via the regular
        get_current_user path — so the in-app editor and sub-office admins
        can use their normal session.
    """
    # Try password first (cheap, no DB hit).
    _check_rate_limit(req)
    supplied = (req.headers.get("X-Editor-Password") or "").strip()
    expected = _expected_password()
    locked = _global_locked()
    if expected and supplied and not locked and hmac.compare_digest(supplied.encode(), expected.encode()):
        _clear_failures(req)
        return {"mode": "shared", "user": None}

    # Fall back to admin auth.
    try:
        from auth import get_current_user as _gcu  # local import to avoid cycle
        user = await _gcu(req)
        if (user.get("role") or "").lower() == "admin":
            _clear_failures(req)
            return {"mode": "user", "user": user}
    except HTTPException:
        pass
    except Exception:
        pass
    _record_failure(req, password_tried=bool(supplied) and not locked)
    if not expected:
        raise HTTPException(status_code=503, detail="Shared editor access is not configured")
    if locked and supplied:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")
    raise HTTPException(status_code=401, detail="Invalid editor password")


def _scoped_office(auth_ctx: dict, requested: Optional[str]) -> Optional[str]:
    """Pin session-authenticated ordinary admins to their own office.

    The deliberately shareable password retains global editor behaviour;
    bearer/cookie auth follows the application's normal office boundary.
    """
    normalized = None if not requested or requested == "__global__" else requested
    user = auth_ctx.get("user") or {}
    if auth_ctx.get("mode") == "shared" or user.get("is_super_admin"):
        return normalized
    own_office = user.get("office_id")
    if not own_office:
        raise HTTPException(status_code=403, detail="Your account is not assigned to an office")
    if normalized and normalized != own_office:
        raise HTTPException(status_code=403, detail="You can only edit your own office")
    return own_office


async def _scoped_module(auth_ctx: dict, module_id: str) -> dict:
    module = await db.training_modules.find_one({"id": module_id})
    if not module:
        raise HTTPException(status_code=404, detail="Module not found")
    user = auth_ctx.get("user") or {}
    if (
        auth_ctx.get("mode") != "shared"
        and not user.get("is_super_admin")
        and module.get("office_id") != user.get("office_id")
    ):
        raise HTTPException(status_code=403, detail="You can only edit modules for your own office")
    return module


# ──────────────────────────── HTML page ────────────────────────────────────

@router.get("/manual-editor")
async def serve_editor():
    """Serve the static editor page. The page itself is public; the JS gates
    content behind the shared-password check (POST /auth)."""
    if not EDITOR_HTML_PATH.exists():
        raise HTTPException(status_code=500, detail="Editor page missing")
    return FileResponse(str(EDITOR_HTML_PATH), media_type="text/html")


# ──────────────────────────── Auth ─────────────────────────────────────────

class AuthBody(BaseModel):
    password: str


@router.post("/manual-editor/auth")
async def auth_verify(body: AuthBody, request: Request):
    """Stateless auth-check: returns {ok: true} if the password matches.
    Caller stashes the password locally and replays it as `X-Editor-Password`
    on every subsequent request."""
    _check_rate_limit(request)
    expected = _expected_password()
    if not expected:
        raise HTTPException(status_code=503, detail="Shared editor access is not configured")
    if _global_locked():
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")
    if not hmac.compare_digest(body.password.strip().encode(), expected.encode()):
        _record_failure(request, password_tried=True)
        raise HTTPException(status_code=401, detail="Wrong password")
    _clear_failures(request)
    return {"ok": True}


# ──────────────────────────── Read endpoints ───────────────────────────────

@router.get("/manual-editor/offices")
async def list_offices(request: Request):
    auth_ctx = await _check_auth(request)
    office_filter = {}
    user = auth_ctx.get("user") or {}
    if auth_ctx.get("mode") != "shared" and not user.get("is_super_admin"):
        office_filter["id"] = _scoped_office(auth_ctx, user.get("office_id"))
    offices = await db.offices.find(office_filter, {"_id": 0, "id": 1, "name": 1}).sort("name", 1).to_list(100)
    return offices


@router.get("/manual-editor/manual")
async def get_manual(request: Request, office_id: str):
    auth_ctx = await _check_auth(request)
    office_id = _scoped_office(auth_ctx, office_id)
    items = await (
        db.training_manual
        .find({"office_id": office_id}, {"_id": 0})
        .sort([("day_number", 1), ("sequence", 1)])
        .to_list(1000)
    )
    return {"office_id": office_id, "items": items}


# ──────────────────────────── Write endpoints ──────────────────────────────

class ItemUpdate(BaseModel):
    category: Optional[str] = None
    topic: Optional[str] = None
    what_good_looks_like: Optional[str] = None
    expected_outcome: Optional[str] = None
    confidence_expected: Optional[str] = None
    required: Optional[bool] = None
    grade_options: Optional[List[str]] = None


@router.patch("/manual-editor/item")
async def update_item(
    request: Request,
    office_id: str,
    day: int,
    seq: int,
    body: ItemUpdate,
):
    auth_ctx = await _check_auth(request)
    office_id = _scoped_office(auth_ctx, office_id)
    upd = {k: v for k, v in body.dict().items() if v is not None}
    if not upd:
        return {"message": "Nothing to update"}
    res = await db.training_manual.update_one(
        {"office_id": office_id, "day_number": int(day), "sequence": int(seq)},
        {"$set": upd},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    # If grade options changed, propagate to in-flight checklists for this
    # office. office_id ∈ {office, None}: rows are stamped with office_id at
    # creation; the None arm keeps legacy unstamped rows updatable until the
    # startup backfill (core/content_fixes) stamps them. The old exact match
    # hit zero rows because checklist rows historically had no office_id.
    if "grade_options" in upd:
        mid = f"D{int(day)}-{int(seq):02d}"
        cl_filter = {"manual_item_id": mid, "office_id": {"$in": [office_id, None]}}
        await db.delivery_checklist.update_many(
            cl_filter,
            {"$set": {"grade_options": upd["grade_options"]}},
        )
        await db.delivery_checklist.update_many(
            {**cl_filter, "grade": {"$nin": upd["grade_options"] + [None]}},
            {"$set": {"grade": None}},
        )
    return {"ok": True}


class ItemCreate(BaseModel):
    day_number: int
    category: str = ""
    topic: str = ""
    what_good_looks_like: str = ""
    expected_outcome: str = ""
    confidence_expected: Optional[str] = None
    grade_options: Optional[List[str]] = None


@router.post("/manual-editor/item")
async def add_item(request: Request, office_id: str, body: ItemCreate):
    auth_ctx = await _check_auth(request)
    office_id = _scoped_office(auth_ctx, office_id)
    existing = await (
        db.training_manual
        .find({"office_id": office_id, "day_number": body.day_number})
        .sort("sequence", -1)
        .to_list(1)
    )
    next_seq = (existing[0]["sequence"] + 1) if existing else 1
    new_item = {
        "office_id": office_id,
        "day_number": body.day_number,
        "sequence": next_seq,
        "category": body.category or "General",
        "topic": body.topic or "New item",
        "what_good_looks_like": body.what_good_looks_like or "",
        "expected_outcome": body.expected_outcome or "",
        "confidence_expected": (body.confidence_expected or "").strip() or "Understand",
        "required": True,
        "grade_options": body.grade_options or ["Excellent", "Average", "Below Average"],
    }
    await db.training_manual.insert_one(new_item)
    new_item.pop("_id", None)
    return {"ok": True, "item": new_item}


@router.delete("/manual-editor/item")
async def delete_item(request: Request, office_id: str, day: int, seq: int):
    auth_ctx = await _check_auth(request)
    office_id = _scoped_office(auth_ctx, office_id)
    res = await db.training_manual.delete_one(
        {"office_id": office_id, "day_number": int(day), "sequence": int(seq)}
    )
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"ok": True}


class ReorderBody(BaseModel):
    ordered_sequences: List[int]


@router.post("/manual-editor/reorder")
async def reorder_day(
    request: Request,
    office_id: str,
    day: int,
    body: ReorderBody,
):
    """Set the new sequence numbers for items on a given day. The body
    `ordered_sequences` is the list of CURRENT sequence numbers in the new
    desired order. Uses a 2-pass renumber via +1000 offsets to avoid index
    collisions during the rewrite."""
    auth_ctx = await _check_auth(request)
    office_id = _scoped_office(auth_ctx, office_id)
    items = await (
        db.training_manual
        .find({"office_id": office_id, "day_number": int(day)})
        .sort("sequence", 1)
        .to_list(500)
    )
    have = {it["sequence"] for it in items}
    # Pass 1 — bump existing sequences out of the way (+1000)
    for new_seq, old_seq in enumerate(body.ordered_sequences, 1):
        if old_seq in have:
            await db.training_manual.update_one(
                {"office_id": office_id, "day_number": int(day), "sequence": old_seq},
                {"$set": {"sequence": new_seq + 1000}},
            )
    # Pass 2 — collapse back down to 1..N in the requested order
    for new_seq, old_seq in enumerate(body.ordered_sequences, 1):
        await db.training_manual.update_one(
            {
                "office_id": office_id,
                "day_number": int(day),
                "sequence": new_seq + 1000 if old_seq in have else old_seq,
            },
            {"$set": {"sequence": new_seq}},
        )
    return {"ok": True}


# ╔══════════════════════════════════════════════════════════════════════╗
# ║   STAGE 2 / 3 / 4  — Rich training_modules editor endpoints          ║
# ╚══════════════════════════════════════════════════════════════════════╝
# These mirror the training_manual editors but operate on the rich-content
# `training_modules` collection (the one that powers Stage 2 trainee learning,
# Stage 3 leadership development, and the future Stage 4 advanced track).
# Modules are scoped by office_id (None = global template).

ALLOWED_STAGES = (2, 3, 4)


def _strip(d: Optional[dict]) -> Optional[dict]:
    if not d:
        return d
    d.pop("_id", None)
    return d


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _office_filter(office_id: Optional[str]) -> dict:
    """Build a Mongo filter for office scoping. office_id can be:
      - None / "" / "__global__"  → match office_id == None (global template)
      - "<actual-id>"             → match that office_id"""
    if not office_id or office_id == "__global__":
        return {"office_id": None}
    return {"office_id": office_id}


@router.get("/manual-editor/modules")
async def list_modules(
    request: Request,
    stage: int,
    office_id: Optional[str] = None,
):
    """List all modules at a stage for an office (or global). Always returns
    sorted by sequence so the UI can render in stable order."""
    auth_ctx = await _check_auth(request)
    if stage not in ALLOWED_STAGES:
        raise HTTPException(status_code=400, detail=f"Stage must be one of {ALLOWED_STAGES}")
    office_id = _scoped_office(auth_ctx, office_id)
    flt = {**_office_filter(office_id), "stage": stage}
    cursor = (
        db.training_modules
        .find(flt, {"_id": 0})
        .sort([("sequence", 1), ("category", 1), ("topic", 1)])
    )
    items = await cursor.to_list(500)
    return {
        "stage": stage,
        "office_id": office_id or None,
        "is_global": not office_id or office_id == "__global__",
        "items": items,
    }


class ModulePatch(BaseModel):
    category: Optional[str] = None
    topic: Optional[str] = None
    trainee_content: Optional[str] = None
    what_good_looks_like: Optional[List[str]] = None
    how_measured: Optional[List[str]] = None
    leader_coaching_notes: Optional[List[str]] = None
    assessment_prompts: Optional[Dict[str, str]] = None
    sequence: Optional[int] = None


@router.patch("/manual-editor/module/{module_id}")
async def update_module(module_id: str, request: Request, body: ModulePatch):
    auth_ctx = await _check_auth(request)
    await _scoped_module(auth_ctx, module_id)
    upd = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    if not upd:
        return {"message": "Nothing to update"}
    upd["updated_at"] = _now_iso()
    res = await db.training_modules.update_one({"id": module_id}, {"$set": upd})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Module not found")
    return {"ok": True}


class ModuleCreate(BaseModel):
    stage: int
    category: str = "General"
    topic: str = "New module"
    trainee_content: str = ""
    what_good_looks_like: List[str] = []
    how_measured: List[str] = []
    leader_coaching_notes: List[str] = []
    assessment_prompts: Dict[str, str] = {}
    office_id: Optional[str] = None  # None = global


@router.post("/manual-editor/module")
async def create_module(request: Request, body: ModuleCreate):
    auth_ctx = await _check_auth(request)
    if body.stage not in ALLOWED_STAGES:
        raise HTTPException(status_code=400, detail=f"Stage must be one of {ALLOWED_STAGES}")
    office_id = _scoped_office(auth_ctx, body.office_id)
    flt = {**_office_filter(office_id), "stage": body.stage}
    last = await db.training_modules.find(flt).sort("sequence", -1).limit(1).to_list(1)
    next_seq = (last[0].get("sequence", 0) + 1) if last else 1
    prompts = body.assessment_prompts or {
        "knowledge": f"Can clearly explain {body.topic.lower()}",
        "skill": f"Can demonstrate {body.topic.lower()} in field or roleplay",
        "consistency": f"Applies {body.topic.lower()} reliably",
        "independence": f"Uses {body.topic.lower()} without coach prompting",
    }
    doc = {
        "id": str(uuid.uuid4()),
        "stage": body.stage,
        "category": body.category,
        "topic": body.topic,
        "trainee_content": body.trainee_content,
        "what_good_looks_like": body.what_good_looks_like,
        "how_measured": body.how_measured,
        "leader_coaching_notes": body.leader_coaching_notes,
        "assessment_prompts": prompts,
        "office_id": office_id,
        "sequence": next_seq,
        "created_at": _now_iso(),
    }
    await db.training_modules.insert_one(doc)
    doc.pop("_id", None)
    return {"ok": True, "item": doc}


@router.delete("/manual-editor/module/{module_id}")
async def delete_module(module_id: str, request: Request):
    auth_ctx = await _check_auth(request)
    await _scoped_module(auth_ctx, module_id)
    res = await db.training_modules.delete_one({"id": module_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Module not found")
    await db.module_progress.delete_many({"module_id": module_id})
    return {"ok": True}


class ModulesReorderBody(BaseModel):
    ordered_ids: List[str]


@router.post("/manual-editor/modules/reorder")
async def reorder_modules(
    request: Request,
    stage: int,
    body: ModulesReorderBody,
    office_id: Optional[str] = None,
):
    """Set the new sequence for a list of module ids within a stage scope.
    Two-pass renumber via +10000 offsets to avoid index collisions."""
    auth_ctx = await _check_auth(request)
    if stage not in ALLOWED_STAGES:
        raise HTTPException(status_code=400, detail=f"Stage must be one of {ALLOWED_STAGES}")
    office_id = _scoped_office(auth_ctx, office_id)
    flt = {**_office_filter(office_id), "stage": stage}
    rows = await db.training_modules.find(flt, {"id": 1}).to_list(500)
    valid_ids = {r["id"] for r in rows}
    for new_seq, mid in enumerate(body.ordered_ids, 1):
        if mid in valid_ids:
            await db.training_modules.update_one(
                {"id": mid},
                {"$set": {"sequence": new_seq + 10000}},
            )
    for new_seq, mid in enumerate(body.ordered_ids, 1):
        if mid in valid_ids:
            await db.training_modules.update_one(
                {"id": mid},
                {"$set": {"sequence": new_seq}},
            )
    return {"ok": True}
