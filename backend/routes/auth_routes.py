"""Auth endpoints: login, register, OTP verify, forgot/reset password, profile, push-token, trainee progress, static logo."""
import os
import uuid
import logging
import secrets
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from bson import ObjectId
from bson.errors import InvalidId
from pymongo import ReturnDocument

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
import jwt as pyjwt

from database import db
from core import media_store
from auth import (
    hash_password, verify_password, create_access_token, create_refresh_token,
    set_auth_cookies, get_current_user, require_admin, require_super_admin,
    JWT_SECRET, JWT_ALGORITHM, COOKIE_SECURE, MIN_PASSWORD_LENGTH,
)
from models import (
    LoginRequest, RegisterRequest, ChangePasswordRequest,
    ProfileImageRequest,
)
from core.brand import APP_NAME
from core.email_utils import (
    send_welcome_email, send_otp_email, send_new_hire_email, render_password_reset_email,
)
from core.push import send_push_to_user
from core.trainee_records import create_training_record
from core.rate_limit import client_ip

ROOT_DIR = Path(__file__).parent.parent
logger = logging.getLogger(__name__)
router = APIRouter()

_RATE_BUCKETS: dict[str, list[float]] = {}
_CODE_MAX_ATTEMPTS = 5
_MAX_RATE_BUCKETS = 10_000


def _request_ip(request: Request) -> str:
    # Right-most X-Forwarded-For hop when TRUST_PROXY_HEADERS is on (see
    # core/rate_limit.py); a client-supplied leftmost entry is never trusted.
    return client_ip(request)


def _rate_key(request: Request, scope: str, identity: str = "", *, bind_ip: bool = True) -> str:
    ip = _request_ip(request) if bind_ip else "account"
    return f"{scope}:{ip}:{identity.strip().lower()}"


def _enforce_rate(key: str, limit: int, window_seconds: int) -> None:
    now = time.monotonic()
    cutoff = now - window_seconds
    recent = [stamp for stamp in _RATE_BUCKETS.get(key, []) if stamp >= cutoff]
    if recent:
        _RATE_BUCKETS[key] = recent
    else:
        _RATE_BUCKETS.pop(key, None)
    if len(recent) >= limit:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")


def _record_rate(key: str) -> None:
    if len(_RATE_BUCKETS) >= _MAX_RATE_BUCKETS and key not in _RATE_BUCKETS:
        # Bound untrusted-identity memory use. Drop the stalest bucket; rate
        # limits are best-effort per worker while OTP attempt counts remain
        # durable in Mongo.
        stalest = min(_RATE_BUCKETS, key=lambda k: _RATE_BUCKETS[k][-1] if _RATE_BUCKETS[k] else 0)
        _RATE_BUCKETS.pop(stalest, None)
    _RATE_BUCKETS.setdefault(key, []).append(time.monotonic())


def _clear_rate(key: str) -> None:
    _RATE_BUCKETS.pop(key, None)


def _new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _code_query(email: str, code: str) -> dict:
    return {
        "email": email,
        "code": code,
        "$or": [
            {"attempts": {"$lt": _CODE_MAX_ATTEMPTS}},
            {"attempts": {"$exists": False}},
        ],
    }


def _is_code_expired(record: dict, default_minutes: int) -> bool:
    try:
        created = datetime.fromisoformat(str(record["created_at"]).replace("Z", "+00:00"))
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        minutes = int(record.get("expires_minutes") or default_minutes)
        return datetime.now(timezone.utc) - created > timedelta(minutes=minutes)
    except Exception:
        # Malformed legacy verification rows must fail closed.
        return True


def _code_age_seconds(record: dict) -> float:
    try:
        created = datetime.fromisoformat(str(record["created_at"]).replace("Z", "+00:00"))
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - created).total_seconds())
    except Exception:
        return float("inf")


# ==================== STATIC ASSETS ====================

@router.get("/logo.png")
async def get_logo():
    """Serve the app logo (used in email templates)."""
    for p in [ROOT_DIR / "assets" / "logo.png", ROOT_DIR / "static" / "logo.png"]:
        if p.exists():
            return FileResponse(str(p), media_type="image/png")
    raise HTTPException(status_code=404, detail="Logo not found")

# ==================== AUTH ROUTES ====================

@router.post("/auth/login")
async def login(req: LoginRequest, request: Request, response: Response):
    email = req.email.strip().lower()
    identity_key = _rate_key(request, "login-account", email, bind_ip=False)
    ip_key = _rate_key(request, "login-ip")
    _enforce_rate(identity_key, limit=10, window_seconds=15 * 60)
    _enforce_rate(ip_key, limit=50, window_seconds=15 * 60)
    user = await db.users.find_one({
        "email": email,
        "deleted": {"$ne": True},
        "is_active": {"$ne": False},
    })
    password_ok = False
    if user and user.get("password_hash"):
        try:
            password_ok = verify_password(req.password, user["password_hash"])
        except Exception:
            password_ok = False
    if not user or not password_ok:
        _record_rate(identity_key)
        _record_rate(ip_key)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if user.get("deleted") or user.get("is_active") is False:
        _record_rate(identity_key)
        _record_rate(ip_key)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    # Block login if email not verified (but allow admins/super_admin/legacy users without the field)
    if user.get("email_verified") is False:
        raise HTTPException(
            status_code=403,
            detail={"message": "Please verify your email first", "requires_verification": True, "email": user["email"]},
        )
    # A starter password is only good until its expiry; after that the Owner
    # issues a fresh one (or the person uses Forgot password).
    if user.get("must_change_password") and _starter_expired(user):
        raise HTTPException(status_code=401, detail="That starter password has expired. Ask the Owner for a new one, or use Forgot password.")
    _clear_rate(identity_key)
    user_id = str(user["_id"])
    session_version = int(user.get("session_version") or 0)
    access = create_access_token(user_id, user["email"], session_version)
    refresh = create_refresh_token(user_id, session_version)
    set_auth_cookies(response, access, refresh)
    return {"id": user_id, "email": user["email"], "name": user.get("name", ""), "role": user["role"], "token": access, "refresh_token": refresh,
            "must_change_password": bool(user.get("must_change_password")),
            "profile_image": user.get("profile_image"), "office_id": user.get("office_id"),
            "is_super_admin": user.get("is_super_admin", False),
            "accessible_offices": user.get("accessible_offices", [])}

# Self-registration is CLOSED. Accounts are created by an office admin marking
# someone attended on the live roster, which provisions the account, the hire
# record and the assessments together and emails them a temporary password.
#
# It was open until people started signing themselves up minutes after being
# provisioned — with a different email address — leaving two accounts, two hire
# records and two sets of blank assessments for one person, and a real account
# nobody could tell from the duplicate. Whoever holds the roster decides who
# gets in; there is no second way in.
#
# The route stays and answers clearly rather than 404ing, because older app
# builds still show a Sign Up form and their users deserve to be told where to
# go instead of hitting an unexplained error.
SELF_REGISTRATION_ENABLED = False

_REGISTRATION_CLOSED = (
    "Accounts are set up by your office admin. Ask them to mark you as attended "
    "and you'll be emailed a password to sign in with."
)


@router.post("/auth/register")
async def register(req: RegisterRequest, request: Request, response: Response):
    if not SELF_REGISTRATION_ENABLED:
        # Rate-limited like a real attempt so this can't be used to probe which
        # email addresses already exist.
        _enforce_rate(_rate_key(request, "register-ip"), limit=30, window_seconds=60 * 60)
        _record_rate(_rate_key(request, "register-ip"))
        raise HTTPException(status_code=403, detail=_REGISTRATION_CLOSED)

    email = req.email.strip().lower()
    email_key = _rate_key(request, "register-account", email, bind_ip=False)
    ip_key = _rate_key(request, "register-ip")
    _enforce_rate(email_key, limit=5, window_seconds=60 * 60)
    _enforce_rate(ip_key, limit=30, window_seconds=60 * 60)
    _record_rate(email_key)
    _record_rate(ip_key)
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already registered")
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    if len(req.password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    office_id = req.office_id
    if not office_id:
        first_office = await db.offices.find_one()
        if first_office:
            office_id = first_office.get("id")
    if not office_id or not await db.offices.find_one({"id": office_id}, {"_id": 1}):
        raise HTTPException(status_code=400, detail="Valid office is required")
    # Resolve leader by ID or default to "Unassigned" (admin assigns later)
    leader_name = "Unassigned"
    leader_user_id = None
    if req.leader_id:
        try:
            leader_user = await db.users.find_one({
                "_id": ObjectId(req.leader_id),
                "office_id": office_id,
                "role": {"$in": ["leader", "admin"]},
                "deleted": {"$ne": True},
                "is_active": {"$ne": False},
            })
        except Exception:
            leader_user = None
        if not leader_user:
            raise HTTPException(status_code=400, detail="Coach not found in the selected office")
        leader_name = leader_user.get("name", "Unassigned")
        leader_user_id = req.leader_id
    user_data = {
        "email": email, "password_hash": hash_password(req.password),
        "name": req.name.strip(), "role": "trainee",
        "office_id": office_id, "email_verified": False,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    result = await db.users.insert_one(user_data)
    user_id = str(result.inserted_id)
    await create_training_record(
        db, name=req.name.strip(), office_id=office_id, trainee_user_id=user_id,
        leader_name=leader_name,
    )
    # Set reports_to for hierarchy using resolved leader ID
    if leader_user_id:
        await db.users.update_one({"_id": ObjectId(user_id)}, {"$set": {"reports_to": leader_user_id}})
        try:
            from core.achievements import award
            await award(leader_user_id, "team_builder")
        except Exception:
            pass  # badge is best-effort; registration must never fail on it
    # Generate 6-digit OTP and send verification email (welcome email fires AFTER verification)
    code = _new_code()
    await db.email_otps.delete_many({"email": email})
    await db.email_otps.insert_one({
        "email": email, "code": code,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_minutes": 10,
        "attempts": 0,
    })
    try:
        send_otp_email(req.name.strip(), email, code)
    except Exception as e:
        logger.error(f"OTP email send failed: {e}")
    return {
        "requires_verification": True,
        "email": email,
        "message": "Verification code sent to your email",
    }

@router.post("/auth/verify-email")
async def verify_email(request: Request, response: Response):
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    code = (body.get("code") or "").strip()
    if not email or not code:
        raise HTTPException(status_code=400, detail="Email and code are required")
    rate_key = _rate_key(request, "verify-email", email, bind_ip=False)
    _enforce_rate(rate_key, limit=10, window_seconds=15 * 60)
    record = await db.email_otps.find_one({"email": email})
    if not record:
        _record_rate(rate_key)
        raise HTTPException(status_code=400, detail="Invalid verification code")
    if _is_code_expired(record, 10):
        await db.email_otps.delete_many({"email": email})
        raise HTTPException(status_code=400, detail="Verification code expired. Please request a new one.")
    if record.get("code") != code:
        updated = await db.email_otps.find_one_and_update(
            {"email": email},
            {"$inc": {"attempts": 1}},
            return_document=ReturnDocument.AFTER,
        )
        _record_rate(rate_key)
        if int((updated or {}).get("attempts") or 0) >= _CODE_MAX_ATTEMPTS:
            await db.email_otps.delete_many({"email": email})
        raise HTTPException(status_code=400, detail="Invalid verification code")
    # Atomically consume the code so concurrent/replayed requests cannot both
    # authenticate. Missing `attempts` remains supported for legacy rows.
    consumed = await db.email_otps.find_one_and_delete(_code_query(email, code))
    if not consumed:
        _record_rate(rate_key)
        raise HTTPException(status_code=400, detail="Invalid verification code")
    user = await db.users.find_one({
        "email": email,
        "deleted": {"$ne": True},
        "is_active": {"$ne": False},
    })
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    await db.users.update_one({"_id": user["_id"]}, {"$set": {"email_verified": True}})
    _clear_rate(rate_key)
    # Send the branded welcome email now that the user is verified
    try:
        send_welcome_email(user.get("name", ""), email)
    except Exception as e:
        logger.error(f"Welcome email after verification failed: {e}")
    # Auto-login the verified user
    user_id = str(user["_id"])
    session_version = int(user.get("session_version") or 0)
    access = create_access_token(user_id, email, session_version)
    refresh = create_refresh_token(user_id, session_version)
    set_auth_cookies(response, access, refresh)
    return {"id": user_id, "email": email, "name": user.get("name", ""), "role": user.get("role", "trainee"), "token": access, "refresh_token": refresh,
            "profile_image": user.get("profile_image"), "office_id": user.get("office_id"),
            "is_super_admin": user.get("is_super_admin", False),
            "accessible_offices": user.get("accessible_offices", [])}

@router.post("/auth/resend-otp")
async def resend_otp(request: Request):
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email is required")
    rate_key = _rate_key(request, "resend-otp", email, bind_ip=False)
    _enforce_rate(rate_key, limit=10, window_seconds=60 * 60)
    _record_rate(rate_key)
    user = await db.users.find_one({
        "email": email,
        "deleted": {"$ne": True},
        "is_active": {"$ne": False},
    })
    if not user:
        # Don't reveal if email exists
        return {"message": "If that email exists, a new code has been sent"}
    if user.get("email_verified") is True:
        raise HTTPException(status_code=400, detail="This account is already verified. Please log in.")
    # Rate limit: 30 second cooldown
    existing = await db.email_otps.find_one({"email": email})
    if existing:
        try:
            created = datetime.fromisoformat(existing["created_at"])
            seconds_since = (datetime.now(timezone.utc) - created).total_seconds()
            if seconds_since < 30:
                raise HTTPException(status_code=429, detail=f"Please wait {int(30 - seconds_since)} seconds before requesting a new code")
        except HTTPException:
            raise
        except Exception:
            pass
    code = _new_code()
    await db.email_otps.delete_many({"email": email})
    await db.email_otps.insert_one({
        "email": email, "code": code,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_minutes": 10,
        "attempts": 0,
    })
    try:
        send_otp_email(user.get("name", ""), email, code)
    except Exception as e:
        logger.error(f"Resend OTP email failed: {e}")
    return {"message": "A new verification code has been sent to your email"}

@router.get("/auth/me")
async def get_me(request: Request):
    user = await get_current_user(request)
    return user


# ── Self-serve email change (Indeed relay addresses only) ────────────────────
#
# Candidates who apply through Indeed reach us via a relay address like
# jane4_x7b@indeedemail.com — sometimes that's the email their account gets
# created with. The app prompts exactly these users to
# swap in their real email on first login. The flow is deliberately closed to
# everyone else: a normal account's email can only be changed by an admin
# (PUT /admin/users/{id}/email), so this can't be used to hop addresses.
#
# Two steps, both authenticated:
#   1. POST /auth/change-email/request {email}  → OTP sent to the NEW address
#   2. POST /auth/change-email/confirm {code}   → email swapped
#
# The OTP to the new address is what protects the account from being locked
# out by a typo'd email — the swap only lands if the user can read mail there.

INDEED_RELAY_DOMAIN = "@indeedemail.com"


def _is_indeed_relay(email: str) -> bool:
    return (email or "").strip().lower().endswith(INDEED_RELAY_DOMAIN)


@router.post("/auth/change-email/request")
async def request_own_email_change(request: Request):
    user = await get_current_user(request)
    current_email = (user.get("email") or "").strip().lower()
    if not _is_indeed_relay(current_email):
        raise HTTPException(status_code=403, detail="Your email can only be changed by your office admin.")

    body = await request.json()
    new_email = (body.get("email") or "").strip().lower()
    if not new_email:
        raise HTTPException(status_code=400, detail="Email is required")
    if len(new_email) > 254:
        raise HTTPException(status_code=400, detail="Email must be 254 characters or fewer.")
    import re as _re
    if not _re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", new_email):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if _is_indeed_relay(new_email):
        raise HTTPException(status_code=400, detail="Please use your personal email, not an Indeed address.")
    if new_email == current_email:
        raise HTTPException(status_code=400, detail="That's already your email.")
    if await db.users.find_one({"email": new_email}):
        raise HTTPException(status_code=400, detail="Another account already uses that email.")

    rate_key = _rate_key(request, "change-email", user["id"], bind_ip=False)
    _enforce_rate(rate_key, limit=6, window_seconds=60 * 60)
    _record_rate(rate_key)

    code = _new_code()
    await db.email_change_otps.delete_many({"user_id": user["id"]})
    await db.email_change_otps.insert_one({
        "user_id": user["id"],
        "new_email": new_email,
        "code": code,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_minutes": 10,
        "attempts": 0,
    })
    try:
        send_otp_email(user.get("name", ""), new_email, code)
    except Exception as e:
        logger.error(f"change-email OTP send failed for {user['id']}: {e}")
        raise HTTPException(status_code=502, detail="Couldn't send the code — check the address and try again.")
    return {"message": "Verification code sent", "email": new_email}


@router.post("/auth/change-email/confirm")
async def confirm_own_email_change(request: Request):
    user = await get_current_user(request)
    old_email = (user.get("email") or "").strip().lower()

    body = await request.json()
    code = (body.get("code") or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Code is required")

    rate_key = _rate_key(request, "change-email-confirm", user["id"], bind_ip=False)
    _enforce_rate(rate_key, limit=10, window_seconds=15 * 60)

    record = await db.email_change_otps.find_one({"user_id": user["id"]})
    if not record:
        _record_rate(rate_key)
        raise HTTPException(status_code=400, detail="Invalid verification code")
    if _is_code_expired(record, 10):
        await db.email_change_otps.delete_many({"user_id": user["id"]})
        raise HTTPException(status_code=400, detail="Code expired. Please request a new one.")
    if record.get("code") != code:
        updated = await db.email_change_otps.find_one_and_update(
            {"user_id": user["id"]},
            {"$inc": {"attempts": 1}},
            return_document=ReturnDocument.AFTER,
        )
        _record_rate(rate_key)
        if int((updated or {}).get("attempts") or 0) >= _CODE_MAX_ATTEMPTS:
            await db.email_change_otps.delete_many({"user_id": user["id"]})
        raise HTTPException(status_code=400, detail="Invalid verification code")
    # Atomically consume so a replayed confirm can't swap the email twice.
    consumed = await db.email_change_otps.find_one_and_delete({
        "user_id": user["id"], "code": code,
        "$or": [{"attempts": {"$lt": _CODE_MAX_ATTEMPTS}}, {"attempts": {"$exists": False}}],
    })
    if not consumed:
        _record_rate(rate_key)
        raise HTTPException(status_code=400, detail="Invalid verification code")

    new_email = consumed["new_email"]
    if await db.users.find_one({"email": new_email}):
        raise HTTPException(status_code=400, detail="Another account already uses that email.")

    # Swap the login email. session_version stays put on purpose — the user is
    # mid-session in the app right now; kicking them out the moment they fix
    # their email would read as a failure. Their password is unchanged.
    await db.users.update_one(
        {"_id": ObjectId(user["id"])},
        {"$set": {"email": new_email, "email_verified": True}},
    )
    await db.email_otps.delete_many({"email": old_email})
    await db.password_resets.delete_many({"email": old_email})
    _clear_rate(rate_key)

    logger.info(f"change-email: {user['id']} {old_email} -> {new_email}")
    return {"message": "Email updated.", "email": new_email, "old_email": old_email}

@router.put("/auth/push-token")
async def save_push_token(request: Request):
    """Store the authenticated user's Expo push token."""
    user = await get_current_user(request)
    body = await request.json()
    token = (body.get("token") or "").strip()
    if not token:
        # Empty token = remove (logout scenario)
        await db.users.update_one({"_id": ObjectId(user["id"])}, {"$unset": {"expo_push_token": ""}})
        return {"message": "Push token cleared"}
    if not token.startswith("ExponentPushToken"):
        raise HTTPException(status_code=400, detail="Invalid Expo push token format")
    await db.users.update_one({"_id": ObjectId(user["id"])}, {"$set": {"expo_push_token": token}})
    return {"message": "Push token saved"}


@router.put("/auth/team-name")
async def set_my_team_name(request: Request):
    """Leader/admin sets their own team name. This name propagates visually to
    everyone in their subtree (up to 6 generations) on the Bells screen."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Only coaches or admins can set a team name")
    body = await request.json()
    raw = (body.get("team_name") or "").strip()
    if raw and len(raw) > 40:
        raise HTTPException(status_code=400, detail="Team name must be 40 characters or fewer")
    if raw:
        await db.users.update_one({"_id": ObjectId(user["id"])}, {"$set": {"team_name": raw}})
    else:
        await db.users.update_one({"_id": ObjectId(user["id"])}, {"$unset": {"team_name": ""}})
    # OwnerIQ — create/rename this leader's team in the family tree.
    # Fire-and-forget; gated by OWNERIQ_WRITES_ENABLED.
    if raw:
        try:
            import asyncio as _aio
            from owneriq_write import hook_team_name
            _aio.create_task(hook_team_name(user["id"], raw))
        except Exception as _e:
            logger.warning(f"OwnerIQ team-name hook skipped: {_e}")
    return {"ok": True, "team_name": raw or None}

@router.get("/trainee/my-progress")
async def get_trainee_progress(request: Request):
    user = await get_current_user(request)
    if user.get("role") != "trainee":
        raise HTTPException(status_code=403, detail="New BA access only")
    hire_id = user.get("new_hire_id")
    if not hire_id:
        raise HTTPException(status_code=404, detail="No 8-day record found")
    hire = await db.new_hires.find_one({"id": hire_id})
    if not hire:
        raise HTTPException(status_code=404, detail="8-day record not found")
    hire.pop("_id", None)
    assessments = await db.daily_assessments.find({"new_hire_id": hire_id}).sort("day_number", 1).to_list(10)
    for a in assessments:
        a.pop("_id", None)
    return {"hire": hire, "assessments": assessments}

@router.post("/auth/logout")
async def logout(request: Request, response: Response):
    # Signing out is a per-device action, so it must NOT bump session_version —
    # that field is the global revoke-everywhere switch and is reserved for
    # credential changes (change-password, reset-password, admin email change).
    # Bumping it here meant logging out in one browser silently killed the same
    # account's session on every other device, including the installed PWA.
    # Clearing this device's cookies plus the client's stored tokens ends the
    # session locally; the short-lived access token expires on its own.
    await get_current_user(request)
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    return {"message": "Logged out"}

@router.post("/auth/refresh")
async def refresh_token(request: Request, response: Response):
    """Exchange a refresh token for a new access token.

    Accepts the refresh token from either:
      • the `refresh_token` HTTP-only cookie (browser flow), or
      • a JSON body `{ "refresh_token": "..." }` (mobile flow — cookies aren't
        automatically sent by the RN Axios client, so we keep it in AsyncStorage
        and forward it here on 401).
    """
    token = None
    try:
        body = await request.json()
        if isinstance(body, dict):
            token = body.get("refresh_token") or body.get("token")
    except Exception:
        pass
    if not token:
        token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(status_code=401, detail="No refresh token")
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid token type")
        user = await db.users.find_one({
            "_id": ObjectId(payload["sub"]),
            "deleted": {"$ne": True},
            "is_active": {"$ne": False},
        })
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        session_version = int(user.get("session_version") or 0)
        if int(payload.get("ver", 0)) != session_version:
            raise HTTPException(status_code=401, detail="Session revoked")
        user_id = str(user["_id"])
        new_access = create_access_token(user_id, user["email"], session_version)
        # Keep refresh behavior identical to login, including the production
        # Secure-cookie policy configured centrally in auth.py.
        response.set_cookie(
            key="access_token", value=new_access, httponly=True,
            secure=COOKIE_SECURE,
            samesite="lax", max_age=86400, path="/",
        )
        return {"message": "Token refreshed", "token": new_access}
    except (pyjwt.InvalidTokenError, InvalidId, KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid refresh token")

# ── Starter password ─────────────────────────────────────────────────────────
#
# The Owner can give everyone ONE shared password to get in with the first
# time. It is deliberately weak as a secret (it goes out on a group chat), so
# it is fenced in three ways:
#   • an account on it can do nothing except choose its own password
#     (auth.get_current_user) — that is the first screen the app shows;
#   • it expires (STARTER_PASSWORD_DAYS), after which login is refused;
#   • admins are left out unless asked for, so the office's keys never sit
#     behind a password the whole team knows.
# Anyone who knows a colleague's email could still claim that account before
# its owner does, which is why the window is short and the status endpoint
# shows who has not yet changed theirs.

STARTER_PASSWORD_DAYS = 7


def _starter_expired(user: dict) -> bool:
    exp = user.get("starter_password_expires_at")
    if not exp:
        return False
    try:
        t = datetime.fromisoformat(str(exp))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > t
    except ValueError:
        return False


class StarterPasswordBody(BaseModel):
    password: str
    days: int = STARTER_PASSWORD_DAYS
    include_admins: bool = False
    dry_run: bool = True


def _starter_scope(admin: dict, include_admins: bool) -> dict:
    q: dict = {"deleted": {"$ne": True}, "is_active": {"$ne": False}, "is_demo": {"$ne": True},
               "_id": {"$ne": ObjectId(admin["id"])}}
    if not include_admins:
        q["role"] = {"$ne": "admin"}
    return q


@router.post("/admin/starter-password")
async def set_starter_password(body: StarterPasswordBody, request: Request):
    """Super admin: put everyone on one shared first-login password. Each
    person must choose their own the moment they sign in. `dry_run` (the
    default) only reports who would be affected."""
    admin = await require_super_admin(request)
    if len(body.password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"The starter password must be at least {MIN_PASSWORD_LENGTH} characters")
    days = max(1, min(int(body.days or STARTER_PASSWORD_DAYS), 30))
    q = _starter_scope(admin, body.include_admins)
    people = await db.users.find(q, {"name": 1, "email": 1, "role": 1}).to_list(5000)
    out = {"dry_run": body.dry_run, "count": len(people), "days": days,
           "people": sorted(({"name": p.get("name"), "email": p.get("email"), "role": p.get("role")} for p in people),
                            key=lambda r: (r["name"] or "").lower())}
    if body.dry_run:
        return out
    now = datetime.now(timezone.utc)
    await db.users.update_many(q, {
        "$set": {"password_hash": hash_password(body.password), "must_change_password": True,
                 "starter_password_set_at": now.isoformat(),
                 "starter_password_expires_at": (now + timedelta(days=days)).isoformat()},
        "$inc": {"session_version": 1},
    })
    out["expires_at"] = (now + timedelta(days=days)).isoformat()
    return out


@router.get("/admin/starter-password/status")
async def starter_password_status(request: Request):
    """Admin: who is still on the starter password, and who has chosen their own."""
    admin = await require_admin(request)
    q: dict = {"deleted": {"$ne": True}, "is_active": {"$ne": False}}
    if not admin.get("is_super_admin"):
        # An office admin sees their own office only.
        q["office_id"] = admin.get("office_id") or "__none__"
    waiting, done = [], 0
    async for u in db.users.find(q,
                                 {"name": 1, "email": 1, "role": 1, "must_change_password": 1,
                                  "starter_password_expires_at": 1, "password_changed_at": 1}):
        if u.get("must_change_password"):
            waiting.append({"name": u.get("name"), "email": u.get("email"), "role": u.get("role"),
                            "expired": _starter_expired(u), "expires_at": u.get("starter_password_expires_at")})
        elif u.get("password_changed_at"):
            done += 1
    waiting.sort(key=lambda r: (r["name"] or "").lower())
    return {"waiting": waiting, "waiting_count": len(waiting), "changed_count": done}


@router.put("/auth/change-password")
async def change_password(req: ChangePasswordRequest, request: Request, response: Response):
    user = await get_current_user(request)
    full_user = await db.users.find_one({"_id": ObjectId(user["id"])})
    if not full_user:
        raise HTTPException(status_code=404, detail="User not found")
    if not verify_password(req.current_password, full_user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(req.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"New password must be at least {MIN_PASSWORD_LENGTH} characters")
    if req.new_password == req.current_password:
        raise HTTPException(status_code=400, detail="Choose a new password that's different from the current one")
    await db.users.update_one(
        {"_id": ObjectId(user["id"])},
        {
            "$set": {"password_hash": hash_password(req.new_password), "password_changed_at": datetime.now(timezone.utc).isoformat()},
            # Their own password now: the starter-password hold comes off.
            "$unset": {"must_change_password": "", "starter_password_expires_at": ""},
            "$inc": {"session_version": 1},
        },
    )
    new_version = int(full_user.get("session_version") or 0) + 1
    access = create_access_token(user["id"], full_user["email"], new_version)
    refresh = create_refresh_token(user["id"], new_version)
    set_auth_cookies(response, access, refresh)
    return {
        "message": "Password changed successfully",
        "token": access,
        "refresh_token": refresh,
    }

@router.put("/auth/profile-image")
async def upload_profile_image(req: ProfileImageRequest, request: Request):
    user = await get_current_user(request)
    if len(req.image) > 2_800_000:
        raise HTTPException(status_code=400, detail="Image too large (max 2MB)")
    if not media_store.enabled():
        # No bucket configured (local runs): keep the old inline storage.
        await db.users.update_one({"_id": ObjectId(user["id"])}, {"$set": {"profile_image": req.image}})
        return {"message": "Profile image updated", "profile_image": req.image}
    try:
        url, _key = await media_store.store_avatar(user["id"], req.image)
    except ValueError:
        raise HTTPException(status_code=400, detail="Couldn't read that image. Try a JPEG or PNG.")
    except RuntimeError:
        raise HTTPException(status_code=502, detail="Couldn't save the photo right now. Try again.")
    previous = await db.users.find_one({"_id": ObjectId(user["id"])}, {"profile_image": 1})
    await db.users.update_one({"_id": ObjectId(user["id"])}, {"$set": {"profile_image": url}})
    await media_store.delete_avatar_url((previous or {}).get("profile_image"))
    return {"message": "Profile image updated", "profile_image": url}

@router.delete("/auth/profile-image")
async def remove_own_profile_image(request: Request):
    user = await get_current_user(request)
    previous = await db.users.find_one({"_id": ObjectId(user["id"])}, {"profile_image": 1})
    await db.users.update_one({"_id": ObjectId(user["id"])}, {"$unset": {"profile_image": ""}})
    await media_store.delete_avatar_url((previous or {}).get("profile_image"))
    return {"message": "Profile image removed"}

# ==================== PASSWORD RESET ====================

@router.post("/auth/forgot-password")
async def forgot_password(request: Request):
    body = await request.json()
    email = body.get("email", "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email is required")
    rate_key = _rate_key(request, "forgot-password", email, bind_ip=False)
    _enforce_rate(rate_key, limit=5, window_seconds=60 * 60)
    _record_rate(rate_key)
    user = await db.users.find_one({
        "email": email,
        "deleted": {"$ne": True},
        "is_active": {"$ne": False},
    })
    if not user:
        # Don't reveal if email exists
        return {"message": "If that email exists, a reset code has been sent"}
    # Avoid email flooding if the same address is requested repeatedly.
    existing_reset = await db.password_resets.find_one({"email": email})
    if existing_reset and _code_age_seconds(existing_reset) < 60:
        return {"message": "If that email exists, a reset code has been sent"}
    # Generate a cryptographically secure 6-digit code.
    code = _new_code()
    await db.password_resets.delete_many({"email": email})
    await db.password_resets.insert_one({
        "email": email,
        "code": code,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_minutes": 15,
        "attempts": 0,
    })
    # Send email via SendGrid
    sg_key = os.environ.get("SENDGRID_API_KEY")
    from_email = (os.environ.get("SENDGRID_FROM_EMAIL") or "").strip()
    if not sg_key or not from_email:
        logger.error("SENDGRID_API_KEY / SENDGRID_FROM_EMAIL not configured; cannot send password reset email")
        await db.password_resets.delete_many({"email": email})
        raise HTTPException(status_code=500, detail="Email service is not configured. Please contact your admin.")
    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import Mail, From
        message = Mail(
            from_email=From(from_email, (os.environ.get("SENDGRID_FROM_NAME") or "").strip() or None),
            to_emails=email,
            subject=f"{APP_NAME} password reset code",
            html_content=render_password_reset_email(code),
        )
        sg = SendGridAPIClient(sg_key)
        sg.send(message)
        logger.info(f"Password reset email sent to {email}")
    except Exception as e:
        logger.error(f"SendGrid error: {e}")
        await db.password_resets.delete_many({"email": email})
        raise HTTPException(status_code=500, detail="Failed to send reset email. Please contact your admin.")
    return {"message": "If that email exists, a reset code has been sent"}

@router.post("/auth/reset-password")
async def reset_password(request: Request):
    body = await request.json()
    email = body.get("email", "").strip().lower()
    code = body.get("code", "").strip()
    new_password = body.get("new_password", "")
    if not email or not code or not new_password:
        raise HTTPException(status_code=400, detail="Email, code, and new password are required")
    if len(new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    rate_key = _rate_key(request, "reset-password", email, bind_ip=False)
    _enforce_rate(rate_key, limit=10, window_seconds=15 * 60)
    reset_doc = await db.password_resets.find_one({"email": email})
    if not reset_doc:
        _record_rate(rate_key)
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    if _is_code_expired(reset_doc, 15):
        await db.password_resets.delete_many({"email": email})
        raise HTTPException(status_code=400, detail="Reset code has expired. Please request a new one.")
    if reset_doc.get("code") != code:
        updated = await db.password_resets.find_one_and_update(
            {"email": email},
            {"$inc": {"attempts": 1}},
            return_document=ReturnDocument.AFTER,
        )
        _record_rate(rate_key)
        if int((updated or {}).get("attempts") or 0) >= _CODE_MAX_ATTEMPTS:
            await db.password_resets.delete_many({"email": email})
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    consumed = await db.password_resets.find_one_and_delete(_code_query(email, code))
    if not consumed:
        _record_rate(rate_key)
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    # Reset the password (their own now, so any starter-password hold comes off)
    await db.users.update_one(
        {"email": email},
        {
            "$set": {"password_hash": hash_password(new_password), "password_changed_at": datetime.now(timezone.utc).isoformat()},
            "$unset": {"must_change_password": "", "starter_password_expires_at": ""},
            "$inc": {"session_version": 1},
        },
    )
    _clear_rate(rate_key)
    logger.info(f"Password reset successful for {email}")
    return {"message": "Password reset successfully. You can now log in."}

# ==================== ADMIN ROUTES ====================
