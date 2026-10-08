"""Onboarding Hub — "Start Here" content for new starters.

Trainees get an all-in-one first-weeks experience: a welcome word from the
company, what their first weeks look like, how pay works, who to contact,
and where the learning tools live. Everything an admin may want to localise
per office (welcome message, pay notes, contacts) is stored in the
`onboarding_content` collection and merged over sensible defaults, so the
screen always renders even before an admin has customised anything.

Scoping is office-first for multi-office growth:
    GET  /api/onboarding            → office doc → global doc → defaults
    PUT  /api/onboarding/content    → admin upsert (their office, or global
                                      when the admin has no office set)

The GET also resolves the trainee's leader (via users.reports_to) so the
screen can show a real "your leader" contact without a second round trip.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin
from database import db

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ──────────────────────── Defaults ─────────────────────────────────────────
# Field-level fallbacks — an office doc only overrides the fields an admin
# actually filled in, so partial customisation never blanks out the rest.

DEFAULT_CONTENT = {
    # Drawn from the office playbook (First 2 Weeks, Our Expectations, the
    # daily routine and the BA pay rules). Contacts are role titles only —
    # an admin adds the names and numbers; the one number shipped is the
    # charity's Welcome Call line printed in the playbook.
    "welcome_title": "Welcome to the team.",
    "welcome_message": (
        "On Day 1 you'll get a full overview of the business, the direct sales "
        "industry, and the career opportunities ahead of you. You'll learn about "
        "earnings, incentives, and begin studying the sign-up process and "
        "presentation skills. Key focus: absorb everything, ask questions, and get "
        "excited about the opportunity.\n\n"
        "What we expect from you: 100% Effort · Be Proactive · Be Reliable · "
        "Willingness to Listen and Learn · Set Goals · Be Positive · Great Customer "
        "Service · Pushing Boundaries. Always have your notepad ready to take notes "
        "and learn something new — if you don't understand, ask!\n\n"
        "Every top performer started exactly where you are right now."
    ),
    "pay_title": "How your earnings work",
    "pay_notes": (
        "You earn a fee for every sign-up, set by the monthly amount the supporter "
        "chooses: £55 for a £12 standard sign-up, £60 for a £15 target sign-up and "
        "£60 for a £20 premium sign-up. Quality pays too: £15 for every supporter "
        "who reaches their 3rd direct debit, paid 4 months after the sign-up month "
        "in any month your quality rate is 70% or above. Your coach will walk you "
        "through it, and the Pay tab shows what your week is worth."
    ),
    "week_one_note": (
        "Day 1 (Monday): BA Academy Day 1 · Office based (12:30 PM – 6:30 PM)\n"
        "Day 2 (Tuesday): BA Academy Day 2 · Office based (1:00 PM – 5:30 PM)\n"
        "Day 3 (Wednesday): Practical Learning Day · Field based (10:00 AM – 5:30 PM) "
        "— shadow your coach\n"
        "Days 4–5 (Thursday & Friday): First Days on Badge (10:30 AM – 8:30 PM) — "
        "with your mentor by your side\n"
        "Day 6 (Saturday): Badge Development & Consolidation (9:00 AM – 5:30 PM)\n"
        "2nd week: Independent Growth\n\n"
        "Every morning: phone charged + Field IQ working · collect presenter cards & "
        "collateral · recruitment update from admin · review your plan for the day. "
        "After each day your coach goes through the day with you — that's not a "
        "test, it's how we make sure you're supported."
    ),
    "contacts": [  # [{name, role, phone, email}] — admin fills in the people
        {"name": "Marketing Director (the MD)", "role": "Office leadership", "phone": "", "email": ""},
        {"name": "Assistant Director", "role": "Office leadership", "phone": "", "email": ""},
        {"name": "Admin Recruiter", "role": "Support team", "phone": "", "email": ""},
        {"name": "NDCS Welcome Call line", "role": "The number donors save as NDCS",
         "phone": "020 4587 3738", "email": ""},
    ],
    "updated_at": None,
}


# ──────────────────────── Models ──────────────────────────────────────────


class ContactItem(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    role: str = Field("", max_length=120)
    phone: str = Field("", max_length=40)
    email: str = Field("", max_length=200)


class OnboardingContentBody(BaseModel):
    welcome_title: Optional[str] = Field(None, max_length=200)
    welcome_message: Optional[str] = Field(None, max_length=4000)
    pay_title: Optional[str] = Field(None, max_length=200)
    pay_notes: Optional[str] = Field(None, max_length=4000)
    week_one_note: Optional[str] = Field(None, max_length=4000)
    contacts: Optional[List[ContactItem]] = None


# ──────────────────────── Helpers ─────────────────────────────────────────


def _merge_content(*docs: Optional[dict]) -> dict:
    """Layer docs over DEFAULT_CONTENT; later docs win, empty values don't."""
    out = dict(DEFAULT_CONTENT)
    for doc in docs:
        if not doc:
            continue
        for key in DEFAULT_CONTENT:
            val = doc.get(key)
            if val is None:
                continue
            if isinstance(val, str) and not val.strip():
                continue
            # An empty list falls back to the default — except contacts, where
            # an admin who removed every default contact meant it.
            if isinstance(val, list) and not val and key != "contacts":
                continue
            out[key] = val
    return out


async def _resolve_leader(user: dict) -> Optional[dict]:
    """Trainee's leader as a lightweight contact card (or None)."""
    rt = user.get("reports_to")
    if not rt:
        return None
    try:
        leader = await db.users.find_one({"_id": ObjectId(rt)})
    except (InvalidId, TypeError, ValueError):
        leader = None
    if not leader:
        return None
    return {
        "name": leader.get("name") or "",
        "role": (leader.get("role") or "leader").capitalize(),
        "email": leader.get("email") or "",
        "phone": leader.get("phone") or "",
        "profile_image": leader.get("profile_image") or "",
    }


# ──────────────────────── Routes ──────────────────────────────────────────


@router.get("/onboarding")
async def get_onboarding(request: Request):
    user = await get_current_user(request)
    office_id = user.get("office_id")

    global_doc = await db.onboarding_content.find_one({"office_id": None}, {"_id": 0})
    office_doc = None
    if office_id:
        office_doc = await db.onboarding_content.find_one(
            {"office_id": office_id}, {"_id": 0}
        )

    office = None
    if office_id:
        office = await db.offices.find_one(
            {"id": office_id},
            {"_id": 0, "id": 1, "name": 1, "city": 1, "state": 1, "new_hire_training_pay": 1}
        )

    return {
        "content": _merge_content(global_doc, office_doc),
        "leader": await _resolve_leader(user),
        "office": office,
        "can_edit": (user.get("role") == "admin") or bool(user.get("is_super_admin")),
    }


@router.put("/onboarding/content")
async def put_onboarding_content(body: OnboardingContentBody, request: Request):
    admin = await require_admin(request)
    office_id = admin.get("office_id") or None

    update = {}
    for key in ("welcome_title", "welcome_message", "pay_title", "pay_notes", "week_one_note"):
        val = getattr(body, key)
        if val is not None:
            update[key] = val.strip()
    if body.contacts is not None:
        update["contacts"] = [c.model_dump() for c in body.contacts][:12]

    if not update:
        raise HTTPException(status_code=400, detail="Nothing to update")

    update["updated_at"] = _now()
    update["updated_by"] = admin.get("id")

    await db.onboarding_content.update_one(
        {"office_id": office_id},
        {"$set": update, "$setOnInsert": {"office_id": office_id}},
        upsert=True,
    )
    saved = await db.onboarding_content.find_one({"office_id": office_id}, {"_id": 0})
    return {"content": _merge_content(saved), "office_id": office_id}
