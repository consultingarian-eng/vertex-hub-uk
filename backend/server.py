"""Backend API — FastAPI app bootstrap.

This file is now a thin orchestrator:
  - Loads env vars & configures logging
  - Creates the FastAPI app + CORS + /api router
  - Includes all route modules (auth, admin, badges, training)
  - Seeds the super-admin + first office + training manual on startup
All route/endpoint implementations live in /app/backend/routes/*.
Shared helpers live in /app/backend/core/*.
"""
from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import uuid
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from fastapi import FastAPI, APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.middleware.cors import CORSMiddleware

from database import db, client
from core.app_time import APP_TZ
from core.brand import APP_NAME
from seed_data import DAY_TARGETS, TRAINING_MANUAL

# Route modules
from routes.auth_routes import router as auth_router
from routes.admin_routes import router as admin_router
from routes.badges import router as badges_router
from routes.media import router as media_router
from routes.training_routes import router as training_router
from routes.bells import router as bells_router
from routes.bells_parser import router as bells_parser_router
from routes.public_html import router as public_html_router
from routes.roster_share import router as roster_share_router
from routes.schedule import router as schedule_router
from routes.agenda import router as agenda_router
from routes.monthly_planners import router as monthly_planners_router
from routes.weekly_planners import router as weekly_planners_router
from routes.primetime import router as primetime_router
from routes.absences import router as absences_router
from routes.planner_coach import router as planner_coach_router
from routes.coaching import router as coaching_router
from routes.coaching_assistant import router as coaching_assistant_router
from routes.product_knowledge import router as product_knowledge_router
from routes.user_prefs import router as user_prefs_router
from routes.daily_breakdown import router as daily_breakdown_router
from routes.bulletin import router as bulletin_router
from routes.manual_editor import router as manual_editor_router
from routes.modules import router as modules_router
from routes.onboarding import router as onboarding_router
from routes.leader_today import router as leader_today_router
from routes.orientation import router as orientation_router
from routes.streak import router as streak_router
from routes.achievements import router as achievements_router
from routes.owneriq import router as owneriq_router
from owneriq_sync import scheduler_tick as owneriq_scheduler_tick
from routes.reports import router as reports_router
from routes.db_export import router as db_export_router
from routes.launch import router as launch_router
from routes.push_web import router as push_web_router
from routes.notifications import router as notifications_router
from routes.sales_path import router as sales_path_router
from routes.quality import router as quality_router
from routes.people import router as people_router
from routes.insights import router as insights_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title=f"{APP_NAME} API")

# Browser origins allowed to send credentialed cross-origin requests. Native
# Expo clients are not governed by browser CORS. Deployed cross-origin web
# clients must be listed explicitly; the same-origin hosted SPA needs no entry.
_cors_raw = (os.environ.get("CORS_ALLOWED_ORIGINS") or "")
_cors_origins = [o.strip().rstrip("/") for o in _cors_raw.split(",") if o.strip()]
if "*" in _cors_origins:
    raise RuntimeError("CORS_ALLOWED_ORIGINS must list exact origins; wildcard '*' is not allowed")
# A hosted deploy never trusts localhost dev origins by default: Railway sets
# RAILWAY_ENVIRONMENT on every deploy; elsewhere set APP_ENV=production.
_is_hosted = bool((os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("RAILWAY_ENVIRONMENT_NAME") or "").strip()) \
    or (os.environ.get("APP_ENV") or "").strip().lower() in {"production", "prod"}
if not _cors_origins and not _is_hosted:
    _cors_origins = [
        "http://localhost:8081",
        "http://127.0.0.1:8081",
        "http://localhost:19006",
        "http://127.0.0.1:19006",
    ]

from core.rate_limit import proxy_warning as _proxy_warning  # noqa: E402
if _proxy_warning():
    logger.warning(_proxy_warning())

# All API routes are exposed under /api/* (matches the ingress rule).
api_router = APIRouter(prefix="/api")


def _build_version() -> str:
    """Identifier that changes on every deploy — Railway's git SHA, else a
    hash of the built index.html (local/docker builds), else 'dev'."""
    sha = os.environ.get("RAILWAY_GIT_COMMIT_SHA")
    if sha:
        return sha[:12]
    try:
        import hashlib
        index = Path((os.environ.get("WEB_DIST_PATH") or "/app/web-dist")) / "index.html"
        return hashlib.sha1(index.read_bytes()).hexdigest()[:12]
    except OSError:
        return "dev"


BUILD_VERSION = _build_version()


@api_router.get("/version")
async def get_version():
    """Deploy identifier polled by the web app to auto-reload on new deploys."""
    return {"version": BUILD_VERSION}

api_router.include_router(auth_router)
api_router.include_router(admin_router)
api_router.include_router(badges_router)
api_router.include_router(media_router)
api_router.include_router(training_router)
api_router.include_router(bells_router)
api_router.include_router(bells_parser_router)
api_router.include_router(schedule_router)
api_router.include_router(agenda_router)
api_router.include_router(monthly_planners_router)
api_router.include_router(weekly_planners_router)
api_router.include_router(primetime_router)
api_router.include_router(absences_router)
api_router.include_router(planner_coach_router)
api_router.include_router(coaching_router)
api_router.include_router(coaching_assistant_router)
api_router.include_router(product_knowledge_router)
api_router.include_router(user_prefs_router)
api_router.include_router(streak_router)
api_router.include_router(daily_breakdown_router)
api_router.include_router(bulletin_router)
api_router.include_router(manual_editor_router)
api_router.include_router(modules_router)
api_router.include_router(onboarding_router)
api_router.include_router(leader_today_router)
api_router.include_router(orientation_router)
api_router.include_router(achievements_router)
api_router.include_router(owneriq_router)
api_router.include_router(reports_router)
api_router.include_router(db_export_router)
api_router.include_router(push_web_router)
api_router.include_router(notifications_router)
# Sales Development Path — same dark-launch pattern: registered always, 403
# until SALES_PATH_ENABLED=true (+ optional SALES_PATH_OFFICES allowlist).
api_router.include_router(sales_path_router)
api_router.include_router(quality_router)
api_router.include_router(people_router)
api_router.include_router(insights_router)

app.include_router(api_router)

# Public HTML pages mount at ROOT (no /api prefix). launch_router serves the
# branded "open the app" page at /launch and /go — registered before the SPA
# static mount at "/" so it isn't swallowed by the catch-all.
app.include_router(public_html_router)
app.include_router(roster_share_router)
app.include_router(launch_router)

@app.get("/health")
async def health():
    return {"status": "ok"}

# "View As" preview is read-only — block every mutating verb whenever the
# super-admin-only X-View-As-User-Id header is present. One blanket rule so
# no individual route needs to know about preview mode.
# Registered BEFORE CORSMiddleware: Starlette wraps middleware in reverse
# registration order, so CORS (added last → outermost) stamps its headers on
# this guard's 403 — otherwise a cross-origin web client (e.g. the dev server
# on localhost:8081 hitting the prod backend) couldn't read the message.
_PREVIEW_BLOCKED_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

@app.middleware("http")
async def preview_read_only_guard(request: Request, call_next):
    if request.headers.get("X-View-As-User-Id") and request.method in _PREVIEW_BLOCKED_METHODS:
        return JSONResponse(status_code=403, content={"detail": "Preview mode is read-only — exit preview to make changes."})
    return await call_next(request)


# Demo/trial accounts (is_demo: true on the user doc) get full visibility but
# none of their submissions may reach production data. Same blanket approach
# as the preview guard, keyed off the REAL token identity — never the view-as
# target — so a demo user stays read-only even mid-preview. The decision
# lives in auth.demo_write_blocked (unit-tested there); auth endpoints stay
# open so the account still logs in/out and refreshes like any other.
@app.middleware("http")
async def demo_write_guard(request: Request, call_next):
    from auth import demo_read_blocked, demo_write_blocked
    if await demo_write_blocked(request):
        return JSONResponse(status_code=403, content={"detail": "Demo account — this trial doesn't save changes."})
    if await demo_read_blocked(request):
        return JSONResponse(status_code=403, content={"detail": "Demo account — bulk export isn't part of the trial."})
    return await call_next(request)


# Endpoints authenticated by credentials in the request BODY (email+password,
# OTP code, reset code) — not by the ambient cookie — plus refresh/logout,
# which only rotate or clear the caller's own session. A STALE auth cookie
# left in a browser or a native app's retained cookie jar must never veto a
# fresh login: that locks the user out of the exact endpoint that would fix
# their state. CSRF risk is nil here — these handlers parse pydantic JSON
# (an HTML form cannot produce application/json), and none of them act on
# the cookie identity in an attacker-exploitable way.
_CSRF_EXEMPT_PATHS = {
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/verify-email",
    "/api/auth/resend-otp",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/auth/refresh",
    "/api/auth/logout",
}


@app.middleware("http")
async def cookie_csrf_guard(request: Request, call_next):
    """Require a trusted browser Origin for cookie-authenticated writes.

    Bearer-token Expo requests do not use ambient browser credentials and are
    unaffected. SameSite=Lax remains a second layer for the browser flow.
    """
    if request.url.path in _CSRF_EXEMPT_PATHS:
        return await call_next(request)
    has_auth_cookie = bool(
        request.cookies.get("access_token") or request.cookies.get("refresh_token")
    )
    has_bearer = request.headers.get("authorization", "").startswith("Bearer ")
    if request.method in _PREVIEW_BLOCKED_METHODS and has_auth_cookie and not has_bearer:
        origin = (request.headers.get("origin") or "").strip().rstrip("/")
        scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
        host = request.headers.get("x-forwarded-host", request.headers.get("host", ""))
        same_origin = f"{scheme}://{host}".rstrip("/") if host else ""
        content_type = (request.headers.get("content-type") or "").lower()
        # Expo native can retain Set-Cookie but does not send a browser Origin.
        # Its JSON request is non-simple in browsers (therefore preflighted),
        # so allowing this no-Origin native pattern does not reopen form CSRF.
        native_json = (
            not origin
            and content_type.startswith("application/json")
            and request.headers.get("x-cg1-client", "").strip().lower() == "expo-native"
        )
        if not native_json and (not origin or (origin != same_origin and origin not in _cors_origins)):
            return JSONResponse(status_code=403, content={"detail": "Untrusted request origin"})
    return await call_next(request)

# CORS — credentialed requests use the exact allowlist above, never `*`.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Crawlers ─────────────────────────────────────────────────────────────────
# CG1 is the internal app, not a website. It served no robots.txt at all: the
# SPA catch-all answered /robots.txt with index.html, and a robots.txt that
# comes back as HTML is read as "no robots.txt, crawl freely". Googlebot then
# rendered the shell, followed its /api/auth/me call, got a 401, and Search
# Console filed it under "Blocked due to unauthorized request (401)".
#
# Both signals are sent because they do different jobs: robots.txt stops the
# crawl, X-Robots-Tag stops indexing of anything already discovered. The route
# is declared above the mount so it wins — Starlette matches in registration
# order and a mount at "/" swallows everything after it.
@app.middleware("http")
async def no_index(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return response


@app.get("/robots.txt", include_in_schema=False)
async def robots_txt():
    return PlainTextResponse("User-agent: *\nDisallow: /\n")


# Serve the Expo web SPA as a catch-all — mounted last so all API routes above
# take priority. NOTE: StaticFiles(html=True) alone does NOT fall back to
# index.html for unknown paths — it 404s with FastAPI's {"detail":"Not
# Found"}, which is exactly what push-notification deep links (e.g.
# /absence-approvals) hit when they open the PWA cold. SpaStaticFiles adds
# the real SPA fallback: try the exported per-route page ("<path>.html",
# which expo static export produces), then index.html.
_WEB_DIST = (os.environ.get("WEB_DIST_PATH") or "/app/web-dist")
if os.path.isdir(_WEB_DIST):
    from fastapi.staticfiles import StaticFiles
    from starlette.exceptions import HTTPException as StarletteHTTPException

    class SpaStaticFiles(StaticFiles):
        @staticmethod
        def _cache_headers(resp, path: str):
            """HTML must revalidate on every load so a new deploy is picked up
            immediately; the hashed expo bundles are content-addressed and can
            cache forever."""
            if resp.status_code >= 400:
                return resp
            if path.startswith("_expo/") or path.startswith("assets/"):
                resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            elif path.endswith(".html") or path in (".", "", "sw.js", "manifest.json"):
                # "." / "" is StaticFiles' internal name for "/" → index.html
                resp.headers["Cache-Control"] = "no-cache"
            return resp

        async def get_response(self, path: str, scope):
            try:
                resp = await super().get_response(path, scope)
                if resp.status_code != 404:
                    return self._cache_headers(resp, path)
            except StarletteHTTPException as ex:
                if ex.status_code != 404:
                    raise
            for candidate in (f"{path}.html", "index.html"):
                try:
                    resp2 = await super().get_response(candidate, scope)
                    if resp2.status_code != 404:
                        return self._cache_headers(resp2, candidate)
                except StarletteHTTPException:
                    continue
            return self._cache_headers(await super().get_response("index.html", scope), "index.html")

    app.mount("/", SpaStaticFiles(directory=_WEB_DIST, html=True), name="spa")


async def _startup_work():
    """Seed super-admin, offices, targets, and training manual on first boot."""
    # ── Bundled-content seeder (runs first so the rest of the boot sees
    # populated content). Pulls every JSON in /app/backend/seed/ into the
    # corresponding collection IF that collection is below threshold.
    # On a fresh Mongo this loads whatever shared content JSON is bundled
    # (see seed_loader.COLLECTIONS); missing files are simply skipped.
    try:
        from seed_loader import load_bundled_seeds
        await load_bundled_seeds(db)
    except Exception:
        logger.exception("seed_loader: bundled-seed import failed (continuing)")

    # Promotion hygiene — anyone who is now a leader/admin gets their own
    # trainee record retired (idempotent; heals fast-tracked promotions from
    # before the close-out rule existed).
    try:
        from routes.admin_routes import cleanup_promoted_hires
        await cleanup_promoted_hires()
    except Exception:
        logger.exception("promotion cleanup failed (continuing)")

    # Achievement backfill — retroactively award badges (daily/personal/team
    # sales, leadership, Stage 1 Green/completion mastery, module quizzes and
    # Stage 2/3 completion, exam 90%+, cumulative learning days) to people who
    # earned them before the achievement engine existed. Silent + idempotent.
    try:
        from core.achievements import backfill_achievements
        await backfill_achievements()
    except Exception:
        logger.exception("achievement backfill failed (continuing)")

    # Data hygiene — archive ghost hires, heal bad office_ids, prune stale
    # push targets, one-shot orphan cleanup,
    # and hot-collection indexes. Idempotent; every sub-step self-guards.
    try:
        from core.data_hygiene import run_data_hygiene
        await run_data_hygiene(db)
    except Exception:
        logger.exception("data hygiene sweep failed (continuing)")

    # Content fixes — matched-text heal of live training content (GRASP,
    # KPI-number conflicts), orphan-module removal, one-shot PK region
    # tagging, and delivery_checklist office_id backfill. Idempotent;
    # admin-edited docs are never overwritten (exact-match-only updates).
    try:
        from core.content_fixes import run_content_fixes
        await run_content_fixes(db)
    except Exception:
        logger.exception("content fixes sweep failed (continuing)")

    await db.users.create_index("email", unique=True)
    # Primetime reads the whole office's week on every Home render, and writes
    # upsert by (office, week, day, person). One compound index serves both.
    # UNIQUE since 2026-08-14: the old check-then-insert in _write_row could
    # race with _mirror_counterparts and leave two rows for the same person on
    # the same day (a duplicate-key error in the app). Dedupe first —
    # keep the newest by updated_at — or the unique build fails on old data.
    _pt_keys = [("office_id", 1), ("week_ending", 1), ("day_index", 1), ("subject_user_id", 1)]
    try:
        dupes_removed = 0
        async for g in db.primetime_entries.aggregate([
            {"$group": {
                "_id": {"o": "$office_id", "w": "$week_ending", "d": "$day_index", "u": "$subject_user_id"},
                "rows": {"$push": {"id": "$_id", "at": "$updated_at"}},
                "n": {"$sum": 1},
            }},
            {"$match": {"n": {"$gt": 1}}},
        ]):
            stale = sorted(g["rows"], key=lambda r: r.get("at") or "", reverse=True)[1:]
            res = await db.primetime_entries.delete_many({"_id": {"$in": [r["id"] for r in stale]}})
            dupes_removed += res.deleted_count or 0
        if dupes_removed:
            logger.info(f"primetime_entries: removed {dupes_removed} duplicate day-rows")
        # Same key pattern with different options conflicts — drop the old
        # non-unique index (its auto-generated name) before the unique build.
        try:
            await db.primetime_entries.drop_index("office_id_1_week_ending_1_day_index_1_subject_user_id_1")
        except Exception:
            pass  # already dropped on a previous boot
        await db.primetime_entries.create_index(_pt_keys, unique=True, name="uniq_office_week_day_subject")
    except Exception:
        # Never let index maintenance take the app down — fall back to the
        # plain index so reads stay fast, and try again next boot.
        logger.exception("primetime_entries unique-index upgrade failed (continuing)")
        await db.primetime_entries.create_index(_pt_keys)
    # Joining a session looks the host up by session_id alone.
    await db.primetime_entries.create_index([("office_id", 1), ("session_id", 1)])
    # Bells rows are keyed by (office, week, person). UNIQUE since 2026-09-02:
    # the same check-then-insert race primetime had lived in all seven bells
    # writers (POST /bells, both goal PUTs, the planner goal sync + crew save,
    # absence approval, the WhatsApp parser). Two concurrent planner saves left
    # one rep with a second empty week row — the grid's per-user collapse showed
    # the empty one while every writer's find_one updated the other, so his
    # sales and goals "stopped saving". Dedupe first — keep the newest by
    # updated_at — or the unique build fails on old data. Partial on string
    # user_id: legacy rows keyed only by user_name share (office, week, null).
    _bells_keys = [("office_id", 1), ("week_ending", 1), ("user_id", 1)]
    try:
        bells_dupes_removed = 0
        async for g in db.bells_entries.aggregate([
            {"$match": {"user_id": {"$type": "string"}}},
            {"$group": {
                "_id": {"o": "$office_id", "w": "$week_ending", "u": "$user_id"},
                "rows": {"$push": {"id": "$_id", "at": "$updated_at"}},
                "n": {"$sum": 1},
            }},
            {"$match": {"n": {"$gt": 1}}},
        ]):
            stale = sorted(g["rows"], key=lambda r: r.get("at") or "", reverse=True)[1:]
            res = await db.bells_entries.delete_many({"_id": {"$in": [r["id"] for r in stale]}})
            bells_dupes_removed += res.deleted_count or 0
        if bells_dupes_removed:
            logger.info(f"bells_entries: removed {bells_dupes_removed} duplicate week-rows")
        await db.bells_entries.create_index(
            _bells_keys,
            unique=True,
            partialFilterExpression={"user_id": {"$type": "string"}},
            name="uniq_office_week_user",
        )
    except Exception:
        # Never let index maintenance take the app down; try again next boot.
        logger.exception("bells_entries unique-index upgrade failed (continuing)")
    # Sales Development Path — silent level backfill. MUST run after the
    # bells dedupe + unique index above so pre-2026-09-02 duplicate week rows
    # can't double-count a week into a Green Week. No-op while the feature
    # flag is off; awards are notify=False via the missing-doc rule.
    try:
        await db.sales_path.create_index("user_id", unique=True, name="uniq_sales_path_user")
        from core.sales_path import backfill_sales_path
        await backfill_sales_path()
    except Exception:
        logger.exception("sales-path backfill failed (continuing)")
    # Backfill: mark ALL existing users as email_verified=True so they don't get locked out
    # by the new OTP flow. This runs ONCE per server boot but is idempotent.
    bf = await db.users.update_many(
        {"email_verified": {"$exists": False}},
        {"$set": {"email_verified": True}},
    )
    if bf.modified_count > 0:
        logger.info(f"Backfilled email_verified=True for {bf.modified_count} existing users")

    # Super-admin (ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME) + the first
    # office (SEED_OFFICE_NAME) with its targets and training manual.
    from core.bootstrap import seed_admin_and_first_office
    await seed_admin_and_first_office(db)

    # ── One-time migration: backfill office_id on existing badges ─────────────
    # Prior to office scoping, badges had no office_id and were visible to everyone.
    # Copy each badge's creator's office onto the badge so visibility is correctly
    # partitioned going forward. Idempotent — only badges missing office_id are touched.
    from bson import ObjectId as _ObjectId  # lazy import
    async for b in db.badges.find({"$or": [{"office_id": {"$exists": False}}, {"office_id": ""}, {"office_id": None}]}):
        creator_id = b.get("created_by_id") or ""
        creator = None
        if creator_id:
            try:
                creator = await db.users.find_one({"_id": _ObjectId(creator_id)})
            except Exception:
                creator = None
        # Fall back to the first office if creator has no office or was deleted
        office_id = (creator or {}).get("office_id") or ""
        if not office_id:
            first = await db.offices.find_one({}, sort=[("created_at", 1)])
            office_id = first["id"] if first else ""
        if office_id:
            await db.badges.update_one({"_id": b["_id"]}, {"$set": {"office_id": office_id}})
    # No log if nothing changed; the query naturally matches zero docs after first run.

    # ── Migration: Extend training from 6 days to 8 days ───────────────────────
    # Adds day 7 & 8 targets + training_manual items to every office (if missing)
    # and creates day 7 & 8 daily_assessments + delivery_checklist entries for
    # every active new_hire. Fully idempotent — safe to run on every boot.
    try:
        offices_all = await db.offices.find({}).to_list(500)
        for office_doc in offices_all:
            oid = office_doc["id"]
            # 1) Targets for days 7 & 8
            for t in DAY_TARGETS:
                if t["day_number"] in (7, 8):
                    existing_t = await db.targets.find_one({"day_number": t["day_number"], "office_id": oid})
                    if not existing_t:
                        t_doc = dict(t)
                        t_doc["office_id"] = oid
                        await db.targets.insert_one(t_doc)
            # 2) Training manual items for days 7 & 8
            for m in TRAINING_MANUAL:
                if m["day_number"] in (7, 8):
                    existing_m = await db.training_manual.find_one({
                        "day_number": m["day_number"], "sequence": m["sequence"], "office_id": oid
                    })
                    if not existing_m:
                        m_doc = dict(m)
                        m_doc["office_id"] = oid
                        await db.training_manual.insert_one(m_doc)

        # 3) Back-fill assessments + checklist for active hires
        active_hires = await db.new_hires.find({"active": True}).to_list(5000)
        extended_count = 0
        for hire in active_hires:
            hire_id = hire.get("id")
            office_id = hire.get("office_id")
            for day in (7, 8):
                existing_a = await db.daily_assessments.find_one({"new_hire_id": hire_id, "day_number": day})
                if existing_a:
                    continue
                aid = str(uuid.uuid4())
                await db.daily_assessments.insert_one({
                    "id": aid, "new_hire_id": hire_id, "new_hire_name": hire.get("name", ""), "day_number": day,
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
                    "coaching_actions": None, "biggest_weakness": None, "focus_tomorrow": None, "leader_notes": None
                })
                manual_items = await db.training_manual.find(
                    {"day_number": day, "office_id": office_id}
                ).sort("sequence", 1).to_list(500)
                for item in manual_items:
                    await db.delivery_checklist.insert_one({
                        "id": str(uuid.uuid4()), "assessment_id": aid,
                        "manual_item_id": f"D{day}-{item['sequence']:02d}",
                        "topic": item["topic"], "category": item["category"],
                        "confidence_expected": item.get("confidence_expected", "Understand"),
                        "taught": False, "outcome_achieved": False, "confidence_level": "Not yet",
                        "grade": None,
                        "grade_options": item.get("grade_options", ["Excellent", "Average", "Below Average"]),
                        "notes": None,
                        "office_id": office_id
                    })
                extended_count += 1
        if extended_count > 0:
            logger.info(f"Extended {extended_count} assessments to 8-day span across active hires")
    except Exception as ex:
        logger.warning(f"8-day training extension migration failed: {ex}")

    # ── One-shot: recompute checklist_grade_score for all assessments ──────────
    # Rationale: /app/backend/scoring.py now treats "Learnt" in a BINARY
    # (Learnt/Not Learnt) preset as 10, not 7. Existing assessments have stale
    # cached values. Recompute once per boot (cheap); marker prevents re-runs.
    try:
        from scoring import calculate_checklist_grade  # lazy import to avoid cycles
        marker = await db.settings.find_one({"key": "checklist_learnt_recalc_v1"})
        if not marker:
            updated = 0
            async for a in db.daily_assessments.find({}, {"id": 1}):
                aid = a.get("id")
                if not aid:
                    continue
                new_score = await calculate_checklist_grade(aid)
                await db.daily_assessments.update_one(
                    {"id": aid}, {"$set": {"checklist_grade_score": new_score}}
                )
                updated += 1
            await db.settings.insert_one({
                "key": "checklist_learnt_recalc_v1",
                "ran_at": datetime.now(timezone.utc).isoformat(),
                "updated_count": updated,
            })
            logger.info(f"Recomputed checklist_grade_score on {updated} assessments (binary-Learnt fix)")
    except Exception as ex:
        logger.warning(f"checklist_grade_score recompute migration failed: {ex}")


    # ── Background scheduler ─────────────────────────────────────────
    # One AsyncIOScheduler runs every periodic job below (syncs, nudges,
    # reminders). Cron times are in the app timezone (core.app_time — UK time
    # by default), matching the day-boundary the rest of the backend uses.
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        scheduler = AsyncIOScheduler(timezone=APP_TZ)

        # ── OwnerIQ DataByte sync (hourly, all day) ─────────────────────
        # Pulls our office's Field IQ KPIs (doors, spoken-to, pitches, sales,
        # points) from OwnerIQ and upserts them into `owneriq_kpis` for the
        # in-app DataByte mirror. Idempotent; re-pulls yesterday+today each
        # run to catch same-day corrections. No-ops if OWNERIQ_* env unset.
        async def _owneriq_job():
            try:
                await owneriq_scheduler_tick()
            except Exception as ex:
                logger.error(f"OwnerIQ scheduler tick failed: {ex}")
            # Then the Performance Hub (targets, attendance, teams) and the
            # Bells fill for this week, from the KPI rows just pulled.
            try:
                from owneriq_performance import scheduler_tick as performance_tick
                await performance_tick()
            except Exception as ex:
                logger.error(f"OwnerIQ performance tick failed: {ex}")
            # Then the two-way people sync: changes made in OwnerIQ come into the
            # app, the app's changes go to OwnerIQ (writes only when enabled).
            try:
                from owneriq_write import reconcile
                res = await reconcile(dry_run=False, actor="auto:hourly")
                if res.get("pulled") or res.get("applied"):
                    logger.info(f"OwnerIQ two-way sync: pulled={len(res.get('pulled') or [])} applied={res.get('applied')}")
            except Exception as ex:
                logger.error(f"OwnerIQ two-way sync failed: {ex}")

        scheduler.add_job(_owneriq_job, "interval", hours=1, id="owneriq_sync_tick", replace_existing=True)

        # ── OwnerIQ reconcile (daily 04:30 UK time) ──────────────────────────
        # Keeps OwnerIQ aligned to CG1 (parent/active/leader-stage) for every
        # linked rep — the safety net for reps added to OwnerIQ after their CG1
        # assignment. Self-gates: applies writes only when OWNERIQ_WRITES_ENABLED
        # is set, otherwise computes the diff and writes nothing.
        async def _owneriq_reconcile_job():
            try:
                from owneriq_write import reconcile
                res = await reconcile(dry_run=False, actor="auto:daily")
                logger.info(
                    f"OwnerIQ daily reconcile: candidates={res.get('candidates')} "
                    f"applied={res.get('applied')} writes_enabled={res.get('writes_enabled')}"
                )
            except Exception as ex:
                logger.error(f"OwnerIQ daily reconcile failed: {ex}")

        scheduler.add_job(_owneriq_reconcile_job, "cron", hour=4, minute=30,
                          id="owneriq_reconcile_daily", replace_existing=True)

        # ── Sectors (Live Ops) re-settle (daily 03:00 UK time) ───────────────
        # Completed days are cached "final" and never re-fetched, so a late
        # correction to yesterday would be missed. This re-pulls yesterday's
        # whole tree once (after the field day + same-day corrections settle)
        # and overwrites the cache with the settled numbers. No-ops if creds
        # unset. Users can also pull-to-refresh any day to force a re-pull.
        async def _owneriq_resettle_job():
            try:
                from owneriq_live import resettle_yesterday_tick
                await resettle_yesterday_tick()
            except Exception as ex:
                logger.error(f"OwnerIQ resettle job failed: {ex}")

        scheduler.add_job(_owneriq_resettle_job, "cron", hour=3, minute=0,
                          id="owneriq_resettle_daily", replace_existing=True)

        # ── Field days (every 10 minutes) ───────────────────────────────────
        # Keeps the Timeline's hour-by-hour records up to date: refreshes
        # today's door logs through the working day, fills in one missing past
        # day at a time, and summarises every saved log (owneriq_field.py).
        # Then the two-zeroes check: anyone whose two most recent days in were
        # both zeros is flagged for a retrain to the Owner and their upline,
        # once (core/zero_alerts.py).
        async def _field_days_job():
            try:
                from owneriq_field import tick as field_days_tick
                await field_days_tick()
            except Exception as ex:
                logger.error(f"field days job failed: {ex}")
            try:
                from core.zero_alerts import run as zero_alerts_run
                await zero_alerts_run(db)
            except Exception as ex:
                logger.error(f"zero alerts job failed: {ex}")

        scheduler.add_job(_field_days_job, "interval", minutes=10, id="field_days_tick",
                          replace_existing=True, max_instances=1, coalesce=True)

        # ── Weekly Bulletin reminder push (Monday 9:00 AM UK time) ───────────
        # Sends a single push notification to every admin/super-admin every
        # Monday at 09:00 app time (handles GMT/BST automatically). The
        # tap deep-links into /share-bulletins, which auto-generates last
        # week's posters (Sales + Team) and opens the native
        # share sheet — WhatsApp-ready in two taps (no Cloud API needed).
        # The /weekly-share hub stays reachable for manual week-picking.
        async def _weekly_bulletin_push():
            try:
                # Per-user send covers BOTH channels — the old token-filtered
                # send_push_to_token silently skipped web-push-only admins —
                # and lands an in-app inbox row for free.
                from core.push import send_push_to_user
                cur = db.users.find(
                    {
                        "$or": [
                            {"role": "admin"},
                            {"is_super_admin": True},
                        ],
                        "deleted": {"$ne": True},
                        "is_active": {"$ne": False},
                    },
                    {"_id": 1},
                )
                sent = 0
                async for u in cur:
                    await send_push_to_user(
                        str(u["_id"]),
                        title="📣 Bulletins are ready",
                        body="Tap to generate & share last week's bulletins",
                        data={"type": "weekly_bulletins", "url": "/share-bulletins"},
                    )
                    sent += 1
                logger.info(f"weekly_bulletin_push: notified {sent} admin(s)")
            except Exception as ex:
                logger.error(f"weekly bulletin push job failed: {ex}")

        # Mon 09:00 in the app timezone (the scheduler's tz). day_of_week=0
        # is Monday in APScheduler's cron convention.
        scheduler.add_job(
            _weekly_bulletin_push,
            "cron",
            day_of_week="mon",
            hour=9,
            minute=0,
            id="weekly_bulletin_push",
            replace_existing=True,
        )

        # ── Bell-triggered grading reminders (every 30 min) ─────────────
        # If a trainee has a bells entry marked "in" for today/yesterday but
        # their daily assessment is still incomplete, their leader gets a
        # push nudge — repeated every ~3h between 08:30 and 23:00 UK time until
        # the assessment is done. See core/assessment_reminders.py.
        async def _assessment_reminder_job():
            try:
                from core.assessment_reminders import assessment_reminder_tick
                await assessment_reminder_tick()
            except Exception as ex:
                logger.error(f"assessment reminder tick failed: {ex}")

        # ── Team-week badges (hourly) ───────────────────────────────────
        # Awards Team 40/60/100 the same day a team crosses the threshold
        # (bells writes don't recompute subtree totals themselves — too
        # expensive per write). Checks only the CURRENT bells week; history
        # is covered by backfill_achievements() on boot.
        async def _team_badges_job():
            try:
                from core.achievements import award_team_week_badges
                today_local = datetime.now(APP_TZ).date()
                week_ending = today_local + timedelta(days=(6 - today_local.weekday()) % 7)
                await award_team_week_badges(week_ending.isoformat())
            except Exception as ex:
                logger.error(f"team badges job failed: {ex}")

        scheduler.add_job(_team_badges_job, "interval", minutes=60, id="team_week_badges", replace_existing=True)

        # ── Weekly-planner "declare your intention" nudge (10:00 UK time) ────
        # Leaders-only. If a leader's Weekly Planner has nothing in today's
        # "Plan today" boxes (Primetime / Sector / Networking / Crew
        # Meetings) by 10am, they get one push nudge — UNLESS they're
        # marked Ab (absent / day off) on the bells sheet for today.
        async def _weekly_planner_nudge():
            try:
                from core.push import send_push_to_user
                now_local = datetime.now(APP_TZ)
                dow = now_local.weekday()  # 0=Mon .. 6=Sun
                if dow > 5:
                    return  # planner has no Sunday page
                week_ending = (now_local.date() + timedelta(days=(6 - dow) % 7)).isoformat()
                plan_keys = ("primetime", "sector", "networking", "crew_plan")
                cur = db.users.find(
                    {"role": "leader", "deleted": {"$ne": True},
                     "expo_push_token": {"$exists": True, "$nin": [None, ""]}},
                    {"_id": 1},
                )
                sent = 0
                async for u in cur:
                    uid = str(u["_id"])
                    # Day off? Bells marked Ab for today → no nudge.
                    bells = await db.bells_entries.find_one(
                        {"user_id": uid, "week_ending": week_ending}, {"_id": 0, "days": 1}
                    )
                    if bells:
                        bdays = bells.get("days") or []
                        today_status = (bdays[dow] or {}).get("status") if dow < len(bdays) and isinstance(bdays[dow], dict) else None
                        if today_status == "ab":
                            continue
                    doc = await db.weekly_planners.find_one(
                        {"user_id": uid, "week_ending": week_ending}, {"_id": 0, "days": 1}
                    )
                    day = ((doc or {}).get("days") or {}).get(str(dow)) or {}
                    if any((day.get(k) or "").strip() for k in plan_keys):
                        continue
                    await send_push_to_user(
                        uid,
                        "Declare your intention 📋",
                        "The day's about to get started and today's plan is still empty — take 2 minutes to set Primetime, Sector, Networking & Crew.",
                        {"type": "weekly_planner_nudge", "url": "/weekly-planner"},
                    )
                    sent += 1
                logger.info(f"weekly_planner_nudge: nudged {sent} leader(s)")
            except Exception as ex:
                logger.error(f"weekly planner nudge failed: {ex}")

        # ── Primetime "your team isn't planned" nudge ───────────────────
        # Leaders only, and only about their OWN crew. Four slots: 22:00 the
        # night before, then 08:30 / 09:30 / 10:00 on the day, since Primetime
        # itself runs at 11:00. Which day is chased follows the 6pm rollover,
        # so the evening slot asks about tomorrow and the morning ones about
        # today. The tick refuses to send between 23:00 and 08:30 regardless
        # of what it's scheduled at.
        async def _primetime_nudge():
            try:
                from routes.primetime import primetime_nudge_tick
                sent = await primetime_nudge_tick()
                logger.info(f"primetime_nudge: nudged {sent} leader(s)")
            except Exception as ex:
                logger.error(f"primetime nudge failed: {ex}")

        for _slot_h, _slot_m in ((22, 0), (8, 30), (9, 30), (10, 0)):
            scheduler.add_job(
                _primetime_nudge,
                "cron",
                day_of_week="mon-sat",
                hour=_slot_h,
                minute=_slot_m,
                id=f"primetime_nudge_{_slot_h:02d}{_slot_m:02d}",
                replace_existing=True,
            )

        scheduler.add_job(
            _weekly_planner_nudge,
            "cron",
            day_of_week="mon-sat",
            hour=10,
            minute=0,
            id="weekly_planner_nudge",
            replace_existing=True,
        )

        # (The 10:00 "Field Day N — today's targets" morning briefing push
        # to trainees was removed 2026-09 at the owner's request — trainees
        # get their day plan from the app, not a morning notification.)

        scheduler.add_job(
            _assessment_reminder_job,
            "interval",
            minutes=30,
            id="assessment_reminder_tick",
            replace_existing=True,
        )

        # ── Orientation mass-grading nudges (Mon/Tue 18:00 UK time) ──────────
        # Day 1 fires Monday evening (the day the class is created), Day 2
        # Tuesday. Each office with an ungraded orientation cohort gets one
        # push to every active admin, deep-linked to the bulk-grade screen —
        # dedupe is per office per app-time date. See core/orientation_nudge.py.
        async def _orientation_nudge_d1():
            try:
                from core.orientation_nudge import orientation_nudge_tick
                await orientation_nudge_tick(1)
            except Exception as ex:
                logger.error(f"orientation nudge d1 failed: {ex}")

        async def _orientation_nudge_d2():
            try:
                from core.orientation_nudge import orientation_nudge_tick
                await orientation_nudge_tick(2)
            except Exception as ex:
                logger.error(f"orientation nudge d2 failed: {ex}")

        scheduler.add_job(
            _orientation_nudge_d1,
            "cron",
            day_of_week="mon",
            hour=18,
            minute=0,
            id="orientation_nudge_d1",
            replace_existing=True,
        )

        scheduler.add_job(
            _orientation_nudge_d2,
            "cron",
            day_of_week="tue",
            hour=18,
            minute=0,
            id="orientation_nudge_d2",
            replace_existing=True,
        )

        # ── Schedule-block reminders for the installed PWA (web push) ────
        # Native gets local "Starting in 5 min" reminders on-device; browsers
        # can't schedule locally, so the server pushes them to web subscribers
        # 5 min before each block. Web-only channel — no double-send to native.
        async def _schedule_reminder_job():
            try:
                from core.schedule_reminders import schedule_reminder_tick
                await schedule_reminder_tick()
            except Exception as ex:
                logger.error(f"schedule reminder tick failed: {ex}")

        scheduler.add_job(
            _schedule_reminder_job,
            "interval",
            minutes=1,
            id="schedule_reminder_tick",
            replace_existing=True,
        )

        # ── COD quiz pre-generation (every 15 min) ──────────────────────
        # Generates missing module quizzes in the background so tapping
        # "Check your understanding" is instant — including regenerating
        # after the vetting page edits a module's content (hash change).
        async def _quiz_pregen_job():
            try:
                from routes.modules import pregenerate_module_quizzes
                out = await pregenerate_module_quizzes(limit=25)
                if out.get("generated"):
                    logger.info(f"quiz pregen: {out}")
            except Exception as ex:
                logger.error(f"quiz pregen tick failed: {ex}")

        scheduler.add_job(
            _quiz_pregen_job,
            "interval",
            minutes=15,
            id="cod_quiz_pregen_tick",
            replace_existing=True,
        )

        scheduler.start()
        app.state.scheduler = scheduler
        logger.info("Background scheduler started")
    except Exception as ex:
        logger.error(f"Failed to start background scheduler: {ex}")


@app.on_event("startup")
async def startup_seed():
    # Boot work (seeding, backfills, scheduler start) runs in the BACKGROUND so
    # the server binds and answers /health immediately. A slow or unreachable
    # Mongo used to hold the port closed through every retry/timeout and fail
    # the host's healthcheck window (this is exactly how the Railway deploys
    # died); now the app comes up instantly and boot work catches up behind it.
    asyncio.create_task(_startup_work())


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
    try:
        sched = getattr(app.state, "scheduler", None)
        if sched:
            sched.shutdown(wait=False)
    except Exception:
        pass
