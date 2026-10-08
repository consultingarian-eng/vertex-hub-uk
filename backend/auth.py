from fastapi import HTTPException, Request, Response
import bcrypt
import jwt as pyjwt
import logging
from datetime import datetime, timezone, timedelta
from bson import ObjectId
from bson.errors import InvalidId
from dotenv import load_dotenv
import os
from pathlib import Path

# `server.py` also loads this file, but auth is imported directly by tests,
# scripts and some ASGI runners.  Load the local untracked file here too so
# development keeps working while production still reads its injected env.
load_dotenv(Path(__file__).with_name(".env"))

from database import db

logger = logging.getLogger(__name__)

JWT_SECRET = (os.environ.get("JWT_SECRET") or "").strip()
if len(JWT_SECRET) < 32:
    raise RuntimeError(
        "JWT_SECRET must be configured with at least 32 characters; "
        "the API will not start with a missing or weak signing key."
    )
JWT_ALGORITHM = "HS256"
MIN_PASSWORD_LENGTH = 8

# Cookies are a browser fallback; Expo native uses the returned bearer token.
# Default secure so a missing deployment flag cannot leak session cookies over
# plaintext HTTP. Local HTTP development can explicitly set COOKIE_SECURE=false.
COOKIE_SECURE = (os.environ.get("COOKIE_SECURE") or "true").strip().lower() not in {
    "0", "false", "no", "off",
}

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))

def create_access_token(user_id: str, email: str, session_version: int = 0) -> str:
    return pyjwt.encode(
        {
            "sub": user_id, "email": email, "ver": int(session_version or 0),
            "exp": datetime.now(timezone.utc) + timedelta(hours=24), "type": "access",
        },
        JWT_SECRET, algorithm=JWT_ALGORITHM
    )

def create_refresh_token(user_id: str, session_version: int = 0) -> str:
    return pyjwt.encode(
        {
            "sub": user_id, "ver": int(session_version or 0),
            "exp": datetime.now(timezone.utc) + timedelta(days=7), "type": "refresh",
        },
        JWT_SECRET, algorithm=JWT_ALGORITHM
    )

def set_auth_cookies(response: Response, access_token: str, refresh_token: str):
    response.set_cookie(key="access_token", value=access_token, httponly=True, secure=COOKIE_SECURE, samesite="lax", max_age=86400, path="/")
    response.set_cookie(key="refresh_token", value=refresh_token, httponly=True, secure=COOKIE_SECURE, samesite="lax", max_age=604800, path="/")

# What an account still on the shared starter password may call.
STARTER_PASSWORD_ALLOWED = ("/auth/me", "/auth/change-password", "/auth/logout")


async def get_current_user(request: Request) -> dict:
    # Explicit native/API credentials take precedence over ambient cookies.
    # React Native can retain an old cookie after AsyncStorage has a newer
    # token; choosing the cookie first would reject an otherwise valid login.
    auth_header = request.headers.get("Authorization", "")
    token = auth_header[7:].strip() if auth_header.startswith("Bearer ") else None
    if not token:
        token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        user = await db.users.find_one({
            "_id": ObjectId(payload["sub"]),
            "deleted": {"$ne": True},
            "is_active": {"$ne": False},
        })
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        if int(payload.get("ver", 0)) != int(user.get("session_version") or 0):
            raise HTTPException(status_code=401, detail="Session revoked")
        user["id"] = str(user["_id"])
        del user["_id"]
        user.pop("password_hash", None)
        # Starter password: the shared first-login password opens nothing but
        # the door to choosing your own (see routes/auth_routes.py).
        if user.get("must_change_password"):
            path = getattr(getattr(request, "url", None), "path", "") or ""
            if not path.endswith(STARTER_PASSWORD_ALLOWED):
                raise HTTPException(status_code=403, detail="Choose your own password to continue.")
        # "View As" — a super admin previewing the app as a specific trainee
        # or leader. Only ever honored when the REAL authenticated user
        # (just resolved above) is a super admin; fails safe to the real
        # user on any bad/deleted/missing target.
        view_as_id = request.headers.get("X-View-As-User-Id")
        if view_as_id and user.get("is_super_admin"):
            try:
                target = await db.users.find_one({
                    "_id": ObjectId(view_as_id),
                    "deleted": {"$ne": True},
                    "is_active": {"$ne": False},
                })
            except Exception:
                target = None
            if target:
                target["id"] = str(target["_id"])
                del target["_id"]
                target.pop("password_hash", None)
                logger.info(f"view-as: super admin {user['id']} previewing as {target['id']} ({target.get('role')})")
                return target
        return user
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except (InvalidId, KeyError, TypeError):
        raise HTTPException(status_code=401, detail="Invalid token")

# ── Demo/trial accounts ──────────────────────────────────────────────────────
# A user doc with is_demo: true is a walk-around trial: full visibility for
# its role, but no submission may reach production data. server.py's
# demo_write_guard middleware asks demo_write_blocked() about every request;
# the check keys off the REAL token subject — never the X-View-As-User-Id
# target — so a demo super admin stays read-only even while previewing.

DEMO_BLOCKED_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Auth endpoints stay open so the account logs in/out and refreshes normally.
# Password recovery is NOT among them: this login is shared with several
# people, so one of them rotating the credential would lock out the rest.
DEMO_ALLOWED_PATHS = {"/api/auth/login", "/api/auth/refresh", "/api/auth/logout"}

# Reads that happen to be POSTs. The whole point of a trial account is that it
# SEES everything, and these handlers only compute and return — they write
# nothing — so refusing them blanks out working screens (Reports, the bells
# parser, the daily breakdown, planner coaching, the letter drafter) instead of
# protecting anything. Only add a path here after reading its handler end to
# end and confirming it cannot write.
DEMO_ALLOWED_READ_POSTS = {
    "/api/reports/generate",
    "/api/reports/prompt",
    "/api/bells/parse-whatsapp",
    "/api/bells/daily-breakdown",
    "/api/monthly-planners/ai-coach",
    "/api/letters/generate",
    "/api/manual-editor/auth",
}

# The mirror image: GETs a trial account must NOT have. Seeing the product is
# visibility; bulk-exporting the database underneath it is not. db-export
# streams every collection in cg1_production, password hashes included, and a
# shared trial login is exactly the wrong thing to hold that.
DEMO_BLOCKED_READS = {"/api/admin/db-export"}

_demo_ids_cache = {"ids": frozenset(), "at": 0.0}
_DEMO_IDS_TTL_SECONDS = 60.0


async def demo_user_ids() -> frozenset:
    """Ids of is_demo users, cached briefly so the guard costs ~nothing."""
    import time
    now = time.monotonic()
    if now - _demo_ids_cache["at"] > _DEMO_IDS_TTL_SECONDS:
        rows = await db.users.find({"is_demo": True}, {"_id": 1}).to_list(100)
        _demo_ids_cache["ids"] = frozenset(str(r["_id"]) for r in rows)
        _demo_ids_cache["at"] = now
    return _demo_ids_cache["ids"]


def request_token_sub(request: Request):
    """The JWT subject of the REAL authenticated caller, or None. Never raises —
    a bad/absent token just means the normal auth layer handles the request."""
    auth_header = request.headers.get("Authorization", "")
    token = auth_header[7:].strip() if auth_header.startswith("Bearer ") else None
    if not token:
        token = request.cookies.get("access_token")
    if not token:
        return None
    try:
        return pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM]).get("sub")
    except Exception:
        return None


async def is_demo_request(request: Request) -> bool:
    """True when the REAL caller is a demo account — never the View-As target.

    The middleware uses this to refuse writes. Routes use it where a READ has
    a side effect the middleware cannot see: recompute-on-view that would push
    a notification at a real employee, for instance.
    """
    demo_ids = await demo_user_ids()
    if not demo_ids:
        return False
    return request_token_sub(request) in demo_ids


async def demo_write_blocked(request: Request) -> bool:
    """True when this request is a mutation from a demo account and must not run."""
    if request.method not in DEMO_BLOCKED_METHODS:
        return False
    path = request.url.path
    if not path.startswith("/api/"):
        return False
    if path in DEMO_ALLOWED_PATHS or path in DEMO_ALLOWED_READ_POSTS:
        return False
    return await is_demo_request(request)


async def demo_read_blocked(request: Request) -> bool:
    """True when a demo account is reaching for something it may see the
    results of but not the raw material behind — see DEMO_BLOCKED_READS."""
    if request.url.path not in DEMO_BLOCKED_READS:
        return False
    return await is_demo_request(request)


# ── Coach+ ───────────────────────────────────────────────────────────────────
# A Coach the Owner has picked to see the whole office: Live Operations, the
# Performance Hub, Field KPIs and everyone's ID badge. It is a flag on a
# `leader` account (`coach_plus`), not a fourth role, so everything a Coach can
# already do keeps working and nothing else in the app has to learn a new role
# value. The flag means nothing on a BA or an Admin.

def is_coach_plus(user: dict | None) -> bool:
    return bool(user) and user.get("role") == "leader" and bool(user.get("coach_plus"))


def sees_whole_office(user: dict | None) -> bool:
    """Admins and Coach+ read office-wide field numbers; a Coach reads their
    own team's, a BA their own."""
    return bool(user) and (user.get("role") == "admin" or is_coach_plus(user))


def can_use_badges(user: dict | None) -> bool:
    """ID badges: Admins and Coach+ only."""
    return sees_whole_office(user)


async def require_admin(request: Request) -> dict:
    user = await get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

async def require_admin_or_leader(request: Request) -> dict:
    """Allow authenticated admin or leader roles.

    Any finer entitlement or resource scope must be enforced server-side by
    the calling route; frontend passcodes are never an authorization layer.
    """
    user = await get_current_user(request)
    if user.get("role") not in ("admin", "leader"):
        raise HTTPException(status_code=403, detail="Admin or coach access required")
    return user


async def require_super_admin(request: Request) -> dict:
    """Require the owner-level account for global/destructive maintenance."""
    user = await get_current_user(request)
    if user.get("role") != "admin" or not user.get("is_super_admin"):
        raise HTTPException(status_code=403, detail="Super admin access required")
    return user

async def get_subtree_ids(user_id: str):
    """Get a hierarchy subtree without recursing forever on legacy cycles.

    The root is always preserved. Deleted descendants are excluded, while
    inactive descendants remain available to historical/reporting callers;
    authorization call sites add an active filter where required.
    """
    root = str(user_id)
    visited: set[str] = {root}
    ordered = [root]
    frontier = [root]
    max_nodes = 5000
    while frontier and len(ordered) < max_nodes:
        rows = await db.users.find(
            # Demo accounts are spectators: they never appear in anyone's
            # subtree (the root — a demo browsing its own views — is kept).
            {"reports_to": {"$in": frontier}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}},
            {"_id": 1},
        ).to_list(max_nodes)
        next_frontier = []
        for row in rows:
            child_id = str(row["_id"])
            if child_id in visited:
                continue
            visited.add(child_id)
            ordered.append(child_id)
            next_frontier.append(child_id)
            if len(ordered) >= max_nodes:
                break
        frontier = next_frontier
    return ordered

async def can_access_hire(user: dict, hire_id: str) -> bool:
    """Check if user can access a hire's assessments/data based on hierarchy."""
    scoped_hire = None
    if not user.get("is_super_admin"):
        if not user.get("office_id"):
            return False
        scoped_hire = await db.new_hires.find_one({"id": hire_id})
        if not scoped_hire or scoped_hire.get("office_id") != user.get("office_id"):
            return False
    if user.get("role") == "admin":
        if user.get("is_super_admin"):
            return True
        return True
    if user.get("role") == "trainee":
        if user.get("new_hire_id") == hire_id:
            return True
        if scoped_hire and scoped_hire.get("trainee_user_id") == user.get("id"):
            return True
        return False
    if user.get("role") == "leader":
        # Hierarchy is office-local.  Checking this before the legacy
        # leader-name fallback prevents equal names in two offices from
        # authorising a foreign hire by id.
        hire = scoped_hire
        subtree_ids = await get_subtree_ids(user["id"])
        trainee_users = await db.users.find(
            {
                "_id": {"$in": [ObjectId(sid) for sid in subtree_ids]},
                "role": "trainee",
                "office_id": user["office_id"],
                "deleted": {"$ne": True},
                "is_active": {"$ne": False},
            },
            {"new_hire_id": 1}
        ).to_list(500)
        hire_ids_in_subtree = [u.get("new_hire_id") for u in trainee_users if u.get("new_hire_id")]
        leader_names_in_subtree = []
        for sid in subtree_ids:
            u = await db.users.find_one(
                {
                    "_id": ObjectId(sid),
                    "office_id": user["office_id"],
                    "deleted": {"$ne": True},
                    "is_active": {"$ne": False},
                },
                {"name": 1, "role": 1},
            )
            if u and u.get("role") in ("leader", "admin"):
                leader_names_in_subtree.append(u.get("name", ""))
        if hire.get("trainee_user_id"):
            # Stable hierarchy linkage always wins. Display names are not
            # identities and may legitimately be duplicated within an office.
            return (
                str(hire.get("trainee_user_id")) in set(subtree_ids)
                or hire_id in hire_ids_in_subtree
            )
        if hire.get("leader_user_id"):
            # A starter added without an app account: the coach's user id was
            # stored when the record was made, so it decides, never the name.
            return (
                str(hire.get("leader_user_id")) in set(subtree_ids) | {str(user.get("id"))}
                or hire_id in hire_ids_in_subtree
            )
        # Compatibility fallback only for genuinely unlinked legacy rows.
        if hire.get("leader") in leader_names_in_subtree or user.get("name") == hire.get("leader"):
            return True
        return hire_id in hire_ids_in_subtree
    return False
