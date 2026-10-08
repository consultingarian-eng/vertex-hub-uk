"""Weekly Agenda — admin-built office plan that publishes to the schedule.

Data model (collection: weekly_agendas):
  {
    id, office_id, week_ending,
    status: 'draft' | 'preview' | 'published',
    themes: { leaders, office, sales_goal, promotions, customer_service,
              concentration, news, social, shadow_expectation },
    rows: [
      {
        id, label, time_label, schedule_match_title,
        cells: [ { day: 0..5, topic, presenter } ]   # Mon=0..Sat=5
      }
    ],
    created_by_id, created_at, updated_at, published_at,
    auto_fill_matches: [ { agenda_row_id, schedule_block_title } ]
  }
"""
import logging
import os
import uuid
import base64
import json
import re
from datetime import datetime, timezone, date, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from dotenv import load_dotenv

from auth import get_current_user, require_admin
from core.rate_limit import take_ai_quota

load_dotenv()

logger = logging.getLogger(__name__)
router = APIRouter()
from database import db  # the shared client; one DB_NAME default (database.py)

# Mon=0..Sun=6 — agenda only stores Mon..Sat (0..5)
DAYS_IN_AGENDA = list(range(0, 6))

DEFAULT_THEMES: dict = {
    "expectations_1": "",
    "expectations_2": "",
    "leaders": "",            # Leaders Theme
    "topic_theme": "",        # Topic Theme
    "customer_service_theme": "",
    "competition": "",        # Competition This Week
    "concentration": "",
    "news": "",
    "social": "",
}

# Side-panel weekly stats (numeric/text fields, displayed prominently)
DEFAULT_STATS: dict = {
    "weekly_goal": "",
    "promotions": "",
    "personal_recruits": "",
}

# Standardized row labels — kept for backwards compatibility on existing
# Plan docs and as a fallback alias-table in `_match_plan_row_from_title`,
# but the NEW seed-rows logic uses unique schedule_block titles instead so
# the Weekly Plan stays in lock-step with the Schedule tab.
STANDARD_ROW_LABELS = [
    "Sectors",
    "Leaders",
    "Stage 1",
    "Stage 2",
    "Sales Impact",
    "Customer Service",
    "News & Bells",
    "Topic",
    "Product Coaching",
    "Appointments",
]


def _coerce_to_sunday(s: str) -> Optional[str]:
    try:
        d = date.fromisoformat(s)
    except Exception:
        return None
    delta = (6 - d.weekday()) % 7
    return (d + timedelta(days=delta)).isoformat()


def _empty_cells():
    return [{"day": d, "topic": "", "presenter": ""} for d in DAYS_IN_AGENDA]


def _scrub(doc: dict) -> dict:
    if doc and "_id" in doc:
        doc.pop("_id", None)
    return doc


async def _build_seed_rows(office_id: str) -> list:
    """Build agenda rows from the office's CURRENT schedule_blocks.

    Each UNIQUE block title becomes one row, sorted by the earliest
    start_time across blocks of that title. Day cells are pre-filled with
    the block's `presenter` (where present) so the Plan reflects the
    Schedule the user actually edited on the Schedule/Daily tab.

    The Weekly Plan stays in lock-step with the Schedule:
      • Add a new block (with a new title) on the Schedule → new row appears
      • Rename a block → that title becomes the row label
      • Remove a block → the row simply isn't seeded next time

    No more hardcoded STANDARD_ROW_LABELS. Existing weekly_agendas docs
    keep their saved rows verbatim — this seed only matters when the user
    is creating a fresh Plan or asks to re-sync via "Fill from Schedule".
    """
    cursor = db.schedule_blocks.find({"office_id": office_id, "audience": {"$ne": "personal"}}, {"_id": 0})
    blocks = await cursor.to_list(500)

    from collections import Counter, defaultdict
    by_key: dict = defaultdict(list)        # lower-case key → blocks
    canonical: dict = {}                     # lower-case key → original casing
    for b in blocks:
        t = (b.get("title") or "").strip()
        if not t:
            continue
        key = t.lower()
        canonical.setdefault(key, t)
        by_key[key].append(b)

    def _earliest_minute(blks: list) -> int:
        mins: list = []
        for b in blks:
            s = (b.get("start_time") or "")
            if ":" in s:
                try:
                    h, m = s.split(":")
                    mins.append(int(h) * 60 + int(m))
                except Exception:
                    pass
        return min(mins) if mins else 24 * 60 + 1

    sorted_keys = sorted(by_key.keys(), key=lambda k: (_earliest_minute(by_key[k]), canonical[k].lower()))

    rows = []
    for key in sorted_keys:
        match_blocks = by_key[key]
        title = canonical[key]
        # Pretty time = the most-frequent start_time across this title's blocks
        counter = Counter((b.get("start_time") or "") for b in match_blocks if b.get("start_time"))
        most_time = counter.most_common(1)[0][0] if counter else ""
        time_label = _to_pretty_time(most_time)

        cells = _empty_cells()
        for b in match_blocks:
            d = b.get("day_of_week")
            try:
                d_i = int(d)
            except Exception:
                continue
            if d_i not in DAYS_IN_AGENDA:
                continue
            for c in cells:
                if c["day"] == d_i:
                    pres = (b.get("presenter") or "").strip()
                    if pres and not c["presenter"]:
                        c["presenter"] = pres

        rows.append({
            "id": str(uuid.uuid4()),
            "label": title,
            "time_label": time_label,
            "schedule_match_title": title,
            "cells": cells,
        })
    return rows


async def _active_days_by_title(office_id: str) -> dict:
    """Map lower-cased schedule-block title → sorted list of day_of_week
    values (0..5) that title actually occurs on in this office's schedule.
    Drives the editor's "only show the days this row really happens on"
    behavior."""
    cursor = db.schedule_blocks.find({"office_id": office_id}, {"_id": 0, "title": 1, "day_of_week": 1})
    blocks = await cursor.to_list(500)
    out: dict = {}
    for b in blocks:
        t = (b.get("title") or "").strip().lower()
        if not t:
            continue
        try:
            d = int(b.get("day_of_week"))
        except Exception:
            continue
        if d in DAYS_IN_AGENDA:
            out.setdefault(t, set()).add(d)
    return {k: sorted(v) for k, v in out.items()}


def _annotate_active_days(rows: list, day_map: dict) -> list:
    """Attach `active_days` to each row. Display-only — `_normalize_row`
    drops it on save, so it is recomputed from the live schedule on every
    GET. Match by schedule_match_title first, then the row label. Rows with
    no matching schedule blocks get None → editor treats that as all days."""
    for r in rows or []:
        key = (r.get("schedule_match_title") or r.get("label") or "").strip().lower()
        r["active_days"] = day_map.get(key)
    return rows


def _to_pretty_time(hhmm: str) -> str:
    if not hhmm or ":" not in hhmm:
        return ""
    try:
        h, m = hhmm.split(":")
        hh = int(h); mm = int(m)
        ampm = "PM" if hh >= 12 else "AM"
        h12 = hh % 12
        if h12 == 0:
            h12 = 12
        return f"{h12}:{mm:02d} {ampm}"
    except Exception:
        return hhmm


def _normalize_row(raw: dict) -> dict:
    """Clamp incoming row to the expected shape."""
    cells_in = raw.get("cells") or []
    by_day: dict = {}
    for c in cells_in:
        try:
            d = int(c.get("day"))
        except Exception:
            continue
        if d in DAYS_IN_AGENDA:
            by_day[d] = {
                "day": d,
                "topic": (c.get("topic") or "").strip(),
                "presenter": (c.get("presenter") or "").strip(),
            }
    cells_out = [by_day.get(d, {"day": d, "topic": "", "presenter": ""}) for d in DAYS_IN_AGENDA]
    return {
        "id": (raw.get("id") or str(uuid.uuid4())),
        "label": (raw.get("label") or "Topic").strip(),
        "time_label": (raw.get("time_label") or "").strip(),
        "schedule_match_title": (raw.get("schedule_match_title") or "").strip() or None,
        "cells": cells_out,
    }


def _normalize_themes(raw: Optional[dict]) -> dict:
    out = dict(DEFAULT_THEMES)
    if isinstance(raw, dict):
        for k in DEFAULT_THEMES.keys():
            v = raw.get(k)
            if isinstance(v, str):
                out[k] = v.strip()
    return out


def _normalize_stats(raw: Optional[dict]) -> dict:
    out = dict(DEFAULT_STATS)
    if isinstance(raw, dict):
        # Legacy migration: older docs used {goal, leaders, er, sales,
        # advancements}. Map the most-relevant pair into the new keys so
        # existing data isn't lost when the UI re-renders.
        legacy_map = {
            "weekly_goal": ("weekly_goal", "goal", "sales_goal"),
            "promotions": ("promotions", "sales", "advancements"),
            "personal_recruits": ("personal_recruits", "personal", "recruits", "leaders", "er"),
        }
        for new_k, sources in legacy_map.items():
            for s in sources:
                v = raw.get(s)
                if v is None:
                    continue
                if isinstance(v, (int, float)):
                    out[new_k] = str(v)
                    break
                if isinstance(v, str) and v.strip():
                    out[new_k] = v.strip()
                    break
    return out


def _scope_office(user: dict, office: Optional[str]) -> str:
    """Resolve which office a request acts on.

    Only super-admins may target an office other than their own. For everyone
    else an ?office= value is ignored rather than rejected, so a stale or
    hand-edited client can't read another office's plan by guessing an id.
    """
    if office and user.get("is_super_admin"):
        return office
    return user.get("office_id") or ""


def _scope_office_write(admin: dict, requested: Optional[str]) -> str:
    """Resolve the office a write lands on, refusing rather than redirecting.

    The read variant above quietly falls back to the caller's own office. A
    write must not: an admin who believes they are editing office B should get
    an error, never a silent save into office A. Mirrors the check that
    /agenda/row-config has always had — these paths simply never got it.
    """
    own = (admin.get("office_id") or "").strip()
    target = ((requested or "") or own).strip()
    if target and target != own and not admin.get("is_super_admin"):
        raise HTTPException(status_code=403, detail="You can only edit your own office's plan")
    return target


# ──────────────────────────────────────────────────────────────────────────
# GET: returns the agenda for the given week, plus a "seed" preview of rows
# the admin would get if they create one fresh (so the UI can render the
# layout immediately even before any data exists).
# ──────────────────────────────────────────────────────────────────────────
@router.get("/agenda")
async def get_agenda(request: Request, week: Optional[str] = None, office: Optional[str] = None):
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    if user.get("is_super_admin") and office:
        office_id = office
    else:
        office_id = user.get("office_id") or ""
    if not office_id:
        return {"week_ending": None, "agenda": None, "seed_rows": []}

    if week:
        coerced = _coerce_to_sunday(week)
        if not coerced:
            raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
        week_ending = coerced
    else:
        today = date.today()
        offset = (today.weekday() - 6) % 7
        week_ending = (today - timedelta(days=offset)).isoformat()

    doc = await db.weekly_agendas.find_one({"office_id": office_id, "week_ending": week_ending}, {"_id": 0})
    seed_rows: list = []
    fallback_used = False
    if not doc:
        seed_rows = await _build_seed_rows(office_id)
    else:
        # Backfill missing keys for older docs so the frontend always gets a
        # complete shape (themes/stats with all expected sub-fields).
        doc["themes"] = _normalize_themes(doc.get("themes"))
        doc["stats"] = _normalize_stats(doc.get("stats"))

    # ── Leader fallback: if the requested week has no published agenda,
    # surface the most-recently-published one for this office so leaders
    # always see something useful. Admins keep editing the requested week.
    is_admin = user.get("role") == "admin"
    if not is_admin and (doc is None or doc.get("status") != "published"):
        latest = await db.weekly_agendas.find_one(
            {"office_id": office_id, "status": "published"},
            sort=[("week_ending", -1)],
            projection={"_id": 0},
        )
        if latest:
            latest["themes"] = _normalize_themes(latest.get("themes"))
            latest["stats"] = _normalize_stats(latest.get("stats"))
            doc = latest
            week_ending = latest.get("week_ending") or week_ending
            seed_rows = []
            fallback_used = True

    # Annotate rows with the days they actually occur on per the office's
    # current schedule, so the editor can hide dead day-cells.
    day_map = await _active_days_by_title(office_id)
    if doc:
        doc["rows"] = _annotate_active_days(list(doc.get("rows") or []), day_map)
    if seed_rows:
        _annotate_active_days(seed_rows, day_map)

    # Which theme fields this office actually uses (non-empty in the most
    # recently published agenda) — lets the editor collapse unused fields.
    themes_in_use: list = []
    latest_pub = await db.weekly_agendas.find_one(
        {"office_id": office_id, "status": "published"},
        sort=[("week_ending", -1)],
        projection={"_id": 0, "themes": 1},
    )
    if latest_pub:
        t = latest_pub.get("themes") or {}
        themes_in_use = [k for k in DEFAULT_THEMES.keys() if (t.get(k) or "").strip()]

    return {
        "week_ending": week_ending,
        "agenda": _scrub(doc) if doc else None,
        "seed_rows": seed_rows,
        "fallback_to_latest_published": fallback_used,
        "themes_in_use": themes_in_use,
    }


# ──────────────────────────────────────────────────────────────────────────
# Weekly-plan row configuration (per-office).
#
#   row_order:    ordered list of row-label slugs (lowercase, trimmed). Rows
#                 are rendered in this order first, then any unlisted rows
#                 append in their schedule-driven order.
#   hidden_rows:  list of row-label slugs that admins have chosen to hide
#                 from leaders and PDF export.
#
# Persisted on the `offices` doc so it survives agenda week-to-week.
# GET is read-only and available to any leader/admin for their office.
# PUT requires admin + is office-scoped (super-admin can target another
# office by passing ?office=<office_id>).
# ──────────────────────────────────────────────────────────────────────────
def _slugify_label(label: str) -> str:
    return (label or "").strip().lower()


@router.get("/agenda/row-config")
async def get_row_config(request: Request, office: Optional[str] = None):
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    # Super-admins may inspect another office's config via ?office=<id>.
    if user.get("is_super_admin") and office:
        office_id = office
    else:
        office_id = user.get("office_id") or ""
    if not office_id:
        return {"office_id": None, "row_order": [], "hidden_rows": []}
    doc = await db.offices.find_one({"id": office_id}, {"_id": 0, "weekly_plan_row_order": 1, "weekly_plan_hidden_rows": 1})
    return {
        "office_id": office_id,
        "row_order": list(doc.get("weekly_plan_row_order") or []) if doc else [],
        "hidden_rows": list(doc.get("weekly_plan_hidden_rows") or []) if doc else [],
    }


@router.put("/agenda/row-config")
async def put_row_config(request: Request, office: Optional[str] = None):
    admin = await require_admin(request)
    body = await request.json()
    # Office scoping: regular admins can ONLY write to their own office.
    # Super-admins may target a different office via ?office= or body.office_id.
    target_office = (office or body.get("office_id") or admin.get("office_id") or "").strip()
    if not admin.get("is_super_admin") and target_office != (admin.get("office_id") or ""):
        raise HTTPException(status_code=403, detail="You can only edit your own office's plan configuration")
    if not target_office:
        raise HTTPException(status_code=400, detail="office_id is required")
    # Clean & dedupe incoming lists. Slugs must be strings.
    raw_order = body.get("row_order") or []
    raw_hidden = body.get("hidden_rows") or []
    if not isinstance(raw_order, list) or not isinstance(raw_hidden, list):
        raise HTTPException(status_code=400, detail="row_order and hidden_rows must be arrays of strings")
    order_clean: list[str] = []
    seen: set = set()
    for item in raw_order:
        slug = _slugify_label(str(item))
        if slug and slug not in seen:
            order_clean.append(slug)
            seen.add(slug)
    hidden_clean = sorted({_slugify_label(str(x)) for x in raw_hidden if str(x).strip()})
    res = await db.offices.update_one(
        {"id": target_office},
        {"$set": {
            "weekly_plan_row_order": order_clean,
            "weekly_plan_hidden_rows": hidden_clean,
            "weekly_plan_row_config_updated_at": datetime.now(timezone.utc).isoformat(),
            "weekly_plan_row_config_updated_by": admin.get("id"),
        }},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Office not found")
    return {"office_id": target_office, "row_order": order_clean, "hidden_rows": hidden_clean}


# ──────────────────────────────────────────────────────────────────────────
# POST: upsert (admin only). Used both for first save and incremental
# autosaves. Status defaults to 'draft' on first save.
# ──────────────────────────────────────────────────────────────────────────
@router.post("/agenda")
async def upsert_agenda(request: Request):
    admin = await require_admin(request)
    body = await request.json()

    office_id = _scope_office_write(admin, body.get("office_id"))
    if not office_id:
        raise HTTPException(status_code=400, detail="office_id is required")

    week_in = (body.get("week_ending") or "").strip()
    if not week_in:
        raise HTTPException(status_code=400, detail="week_ending is required")
    week_ending = _coerce_to_sunday(week_in)
    if not week_ending:
        raise HTTPException(status_code=400, detail="week_ending must be a valid YYYY-MM-DD date")

    raw_rows = body.get("rows") or []
    if not isinstance(raw_rows, list):
        raw_rows = []
    rows = [_normalize_row(r) for r in raw_rows if isinstance(r, dict)]

    themes = _normalize_themes(body.get("themes"))
    stats = _normalize_stats(body.get("stats"))
    status_in = (body.get("status") or "draft").lower()
    if status_in not in ("draft", "preview"):
        # 'published' is set only via /publish — silently coerce
        status_in = "draft"

    now_iso = datetime.now(timezone.utc).isoformat()
    existing = await db.weekly_agendas.find_one({"office_id": office_id, "week_ending": week_ending}, {"_id": 0})

    # The plan's Sales Goal is the office goal — mirror a CHANGED value onto
    # the office doc + the admins' bells crew-goal rows so Bells shows the
    # same number the plan promises (owner request, Sep 2026).
    async def _mirror_goal_if_changed(prev_stats: Optional[dict]) -> None:
        from core.goal_sync import sync_office_weekly_goal, _as_int
        old_g = _as_int((prev_stats or {}).get("weekly_goal"))
        new_g = _as_int(stats.get("weekly_goal"))
        if old_g != new_g:
            await sync_office_weekly_goal(
                office_id, week_ending, new_g, admin, "POST /agenda", skip_agenda=True,
            )

    if existing:
        # Don't downgrade a published agenda silently — admin must re-publish
        # after edits to change its status away from 'draft'.
        prev_status = existing.get("status") or "draft"
        next_status = status_in if prev_status == "draft" else (
            status_in if status_in in ("draft", "preview") else prev_status
        )
        update = {
            "rows": rows,
            "themes": themes,
            "stats": stats,
            "status": next_status,
            "updated_at": now_iso,
        }
        await db.weekly_agendas.update_one({"id": existing["id"]}, {"$set": update})
        await _mirror_goal_if_changed(existing.get("stats"))
        existing.update(update)
        # Autosave responses get written back into the client's query cache
        # and re-seed the editor draft — annotate the same way GET does so
        # the editor's day-filtering survives an autosave round-trip.
        _annotate_active_days(existing.get("rows") or [], await _active_days_by_title(office_id))
        return _scrub(existing)

    # A brand-new plan inherits a goal already set elsewhere (Bells crew
    # pencil / planner) for this week, so the plan never opens blank while
    # Bells shows a number.
    if not (stats.get("weekly_goal") or "").strip():
        from core.goal_sync import goal_for_week
        inherited = await goal_for_week(office_id, week_ending)
        if inherited is not None:
            stats["weekly_goal"] = str(inherited)

    doc = {
        "id": str(uuid.uuid4()),
        "office_id": office_id,
        "week_ending": week_ending,
        "status": status_in,
        "themes": themes,
        "stats": stats,
        "rows": rows,
        "created_by_id": admin.get("id"),
        "created_at": now_iso,
        "updated_at": now_iso,
        "published_at": None,
    }
    await db.weekly_agendas.insert_one(doc.copy())
    await _mirror_goal_if_changed(None)
    _annotate_active_days(doc.get("rows") or [], await _active_days_by_title(office_id))
    return _scrub(doc)


# ──────────────────────────────────────────────────────────────────────────
# POST publish — flips status to 'published' AND auto-fills matching
# schedule blocks for the same office, propagating each row's cell into
# the matching schedule block's topic + presenter fields.
# ──────────────────────────────────────────────────────────────────────────
@router.post("/agenda/{agenda_id}/publish")
async def publish_agenda(agenda_id: str, request: Request):
    admin = await require_admin(request)
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    overwrite = bool(body.get("overwrite", True))

    doc = await db.weekly_agendas.find_one({"id": agenda_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Agenda not found")
    if not admin.get("is_super_admin") and (
        not admin.get("office_id") or doc.get("office_id") != admin.get("office_id")
    ):
        # Publishing fills that office's schedule: own office only.
        raise HTTPException(status_code=404, detail="Agenda not found")
    office_id = doc["office_id"]

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.weekly_agendas.update_one(
        {"id": agenda_id},
        {"$set": {"status": "published", "published_at": now_iso, "updated_at": now_iso}},
    )

    # Auto-fill matching schedule blocks
    fills = 0
    skipped = 0
    for row in doc.get("rows") or []:
        match_title = (row.get("schedule_match_title") or "").strip()
        if not match_title:
            continue
        for cell in row.get("cells") or []:
            day = cell.get("day")
            topic = (cell.get("topic") or "").strip()
            presenter = (cell.get("presenter") or "").strip()
            if topic == "" and presenter == "":
                continue
            blocks = await db.schedule_blocks.find(
                {"office_id": office_id, "day_of_week": day, "title": match_title, "audience": {"$ne": "personal"}},
                {"_id": 0},
            ).to_list(20)
            for b in blocks:
                upd: dict = {}
                if topic:
                    if overwrite or not (b.get("topic") or "").strip():
                        upd["topic"] = topic
                    else:
                        skipped += 1
                if presenter:
                    if overwrite or not (b.get("presenter") or "").strip():
                        upd["presenter"] = presenter
                    else:
                        skipped += 1
                if upd:
                    upd["updated_at"] = now_iso
                    await db.schedule_blocks.update_one({"id": b["id"]}, {"$set": upd})
                    fills += 1

    fresh = await db.weekly_agendas.find_one({"id": agenda_id}, {"_id": 0})
    return {"agenda": _scrub(fresh), "schedule_blocks_filled": fills, "skipped_filled": skipped}


# ──────────────────────────────────────────────────────────────────────────
# POST copy-from-last-week — clones the previous week's rows + themes into
# the requested week. Status resets to 'draft'.
# ──────────────────────────────────────────────────────────────────────────
@router.post("/agenda/copy-from-last-week")
async def copy_from_last_week(request: Request):
    admin = await require_admin(request)
    body = await request.json()
    office_id = _scope_office_write(admin, body.get("office_id"))
    week_in = (body.get("week_ending") or "").strip()
    if not office_id or not week_in:
        raise HTTPException(status_code=400, detail="office_id + week_ending required")
    target_week = _coerce_to_sunday(week_in)
    if not target_week:
        raise HTTPException(status_code=400, detail="invalid week_ending")
    prev_d = date.fromisoformat(target_week) - timedelta(days=7)
    prev_week = prev_d.isoformat()
    prev = await db.weekly_agendas.find_one({"office_id": office_id, "week_ending": prev_week}, {"_id": 0})
    if not prev:
        raise HTTPException(status_code=404, detail=f"No agenda found for {prev_week}")

    # New rows w/ regenerated ids so they don't collide
    new_rows = []
    for r in prev.get("rows") or []:
        nr = _normalize_row(r)
        nr["id"] = str(uuid.uuid4())
        new_rows.append(nr)

    now_iso = datetime.now(timezone.utc).isoformat()
    existing = await db.weekly_agendas.find_one({"office_id": office_id, "week_ending": target_week}, {"_id": 0})
    prev_themes = _normalize_themes(prev.get("themes"))
    prev_stats = _normalize_stats(prev.get("stats"))

    # A goal ALREADY set for the target week (on the existing plan, or via
    # the Bells crew pencil / planner) wins over last week's copied number —
    # copying a template must never silently revert a goal the owner raised.
    from core.goal_sync import goal_for_week, _as_int as _goal_int
    kept_goal = _goal_int((existing or {}).get("stats", {}).get("weekly_goal"))
    if kept_goal is None:
        kept_goal = await goal_for_week(office_id, target_week)
    if kept_goal is not None:
        prev_stats["weekly_goal"] = str(kept_goal)

    # Copying last week's plan carries its Sales Goal — mirror it onto the
    # target week's bells crew rows + office doc like any other goal edit.
    async def _mirror_copied_goal(old_stats: Optional[dict]) -> None:
        from core.goal_sync import sync_office_weekly_goal, _as_int
        old_g = _as_int((old_stats or {}).get("weekly_goal"))
        new_g = _as_int(prev_stats.get("weekly_goal"))
        if old_g != new_g:
            await sync_office_weekly_goal(
                office_id, target_week, new_g, admin, "POST /agenda/copy-from-last-week",
                skip_agenda=True,
            )

    if existing:
        update = {
            "rows": new_rows,
            "themes": prev_themes,
            "stats": prev_stats,
            "status": "draft",
            "updated_at": now_iso,
        }
        await db.weekly_agendas.update_one({"id": existing["id"]}, {"$set": update})
        await _mirror_copied_goal(existing.get("stats"))
        existing.update(update)
        return _scrub(existing)

    doc = {
        "id": str(uuid.uuid4()),
        "office_id": office_id,
        "week_ending": target_week,
        "status": "draft",
        "themes": prev_themes,
        "stats": prev_stats,
        "rows": new_rows,
        "created_by_id": admin.get("id"),
        "created_at": now_iso,
        "updated_at": now_iso,
        "published_at": None,
    }
    await db.weekly_agendas.insert_one(doc.copy())
    await _mirror_copied_goal(None)
    return _scrub(doc)


# ──────────────────────────────────────────────────────────────────────────
# Title-matcher for Schedule → Plan autofill. Given the title of a
# schedule_block, returns the best-matching STANDARD_ROW_LABEL or None.
#
# Matching order (strict → fuzzy) to avoid the classic "Leaders" substring
# trap (e.g. "MAP / SECTOR LEADERS" must map to Sectors, not Leaders):
#   1. Direct case-insensitive equality against the row label.
#   2. Hand-curated alias table (plural/alternate spellings, handwritten
#      sheet shorthand).
#   3. None → caller should leave the cell untouched.
# ──────────────────────────────────────────────────────────────────────────
_ROW_ALIASES: dict = {
    "Sectors": {"sectors", "sector", "map / sector leaders", "map sector leaders", "sector leaders"},
    "Leaders": {"leaders", "leaders theme"},
    "Stage 1": {"stage 1", "stage1"},
    "Stage 2": {"stage 2", "stage2"},
    "Sales Impact": {"sales impact", "sales-impact"},
    "Customer Service": {"customer service"},
    "News & Bells": {"news & bells", "news and bells", "news bells", "news"},
    "Topic": {"topic", "office theme", "theme"},
    "Product Coaching": {"product coaching", "product", "coaching"},
    "Appointments": {"appointments", "appointment", "initial appointment", "initial appointments",
                     "business presentation", "business presentations",
                     "interviews", "interview", "2nd interview", "second interview"},
}


def _match_plan_row_from_title(title: str) -> Optional[str]:
    if not title:
        return None
    norm = (title or "").strip().lower()
    if not norm:
        return None
    # 1) direct case-insensitive equality
    for label in STANDARD_ROW_LABELS:
        if norm == label.lower():
            return label
    # 2) aliases
    for label, aliases in _ROW_ALIASES.items():
        if norm in aliases:
            return label
    return None


# ──────────────────────────────────────────────────────────────────────────
# POST /api/agenda/fill-from-schedule — for every schedule_block in the
# office whose title matches a Plan row label (exact or alias), drop that
# block's title into the corresponding (day, row) cell of the Plan for the
# requested week. By default we NEVER overwrite existing cell content —
# only empty cells get filled.
#
# Body: { office_id?, week_ending, overwrite?: bool }
# Returns: { ok, filled, skipped, total_blocks, agenda }
# ──────────────────────────────────────────────────────────────────────────
@router.post("/agenda/fill-from-schedule")
async def fill_agenda_from_schedule(request: Request):
    admin = await require_admin(request)
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    office_id = _scope_office_write(admin, body.get("office_id"))
    week_in = (body.get("week_ending") or "").strip()
    overwrite = bool(body.get("overwrite") or False)
    # When True, rows whose label doesn't match any current schedule_block
    # title are REMOVED (their cell content is dropped). Used to clean
    # legacy STANDARD rows after switching to schedule-derived rows.
    reset = bool(body.get("reset") or False)
    if not office_id or not week_in:
        raise HTTPException(status_code=400, detail="office_id + week_ending required")
    week_ending = _coerce_to_sunday(week_in)
    if not week_ending:
        raise HTTPException(status_code=400, detail="invalid week_ending")

    # Load schedule blocks for this office
    blocks = await db.schedule_blocks.find(
        {"office_id": office_id, "audience": {"$ne": "personal"}},
        {"_id": 0, "title": 1, "day_of_week": 1, "start_time": 1, "audience": 1},
    ).to_list(2000)

    # Load (or seed) the Plan doc for this week
    doc = await db.weekly_agendas.find_one({"office_id": office_id, "week_ending": week_ending}, {"_id": 0})
    now_iso = datetime.now(timezone.utc).isoformat()
    if not doc:
        # Create a fresh draft seeded with STANDARD_ROW_LABELS so the admin
        # doesn't have to click "Start weekly plan" first.
        seed_rows = await _build_seed_rows(office_id)
        doc = {
            "id": str(uuid.uuid4()),
            "office_id": office_id,
            "week_ending": week_ending,
            "status": "draft",
            "themes": _normalize_themes(None),
            "stats": _normalize_stats(None),
            "rows": seed_rows,
            "created_by_id": admin.get("id"),
            "created_at": now_iso,
            "updated_at": now_iso,
            "published_at": None,
        }
        await db.weekly_agendas.insert_one(doc.copy())

    rows: list = list(doc.get("rows") or [])
    # Index rows by lowercased label for fast lookup. We DO NOT auto-create
    # STANDARD_ROW_LABELS rows anymore — the Plan stays in lock-step with
    # the Schedule (one row per unique block title).
    rows_by_key: dict = {}
    for r in rows:
        lbl = (r.get("label") or "").strip()
        if lbl and lbl.lower() not in rows_by_key:
            rows_by_key[lbl.lower()] = r

    # Ensure each unique block title has a row. New blocks → new row.
    seen_titles: dict = {}
    for b in blocks:
        t = (b.get("title") or "").strip()
        if not t:
            continue
        seen_titles.setdefault(t.lower(), t)

    for key, title in seen_titles.items():
        if key not in rows_by_key:
            new_row = {
                "id": str(uuid.uuid4()),
                "label": title,
                "time_label": "",
                "schedule_match_title": title,
                "cells": _empty_cells(),
            }
            rows.append(new_row)
            rows_by_key[key] = new_row

    # Reset mode: remove every row whose label doesn't match a current
    # block title. Used to clean legacy rows after switching to schedule-
    # derived rows. We still preserve cells of matching rows.
    if reset:
        rows = [r for r in rows if (r.get("label") or "").strip().lower() in seen_titles]
        # Re-build the lookup so the fill loop below uses the trimmed list
        rows_by_key = {(r.get("label") or "").strip().lower(): r for r in rows}

    filled = 0
    skipped = 0
    filled_details: list = []
    for b in blocks:
        title = (b.get("title") or "").strip()
        day = b.get("day_of_week")
        try:
            day_i = int(day)
        except Exception:
            continue
        if day_i not in DAYS_IN_AGENDA:
            continue
        # Strict title-match: lowercase exact equality. The block title and
        # the row label must agree (since rows ARE the block titles now).
        row = rows_by_key.get(title.lower())
        if not row:
            continue
        # Make sure cells list exists with 6 entries
        cells = row.get("cells") or _empty_cells()
        if len(cells) < len(DAYS_IN_AGENDA):
            cells = _empty_cells()
            row["cells"] = cells
        cell = None
        for c in cells:
            if int(c.get("day")) == day_i:
                cell = c
                break
        if not cell:
            continue
        existing_topic = (cell.get("topic") or "").strip()
        existing_presenter = (cell.get("presenter") or "").strip()
        # Don't overwrite presenter / topic the user typed unless asked.
        if (existing_topic or existing_presenter) and not overwrite:
            skipped += 1
            continue
        # Pull presenter from the schedule block (this is the value the user
        # actually edited on the Schedule/Daily tab — see Issue #1).
        block_presenter = (b.get("presenter") or "").strip()
        if not existing_topic:
            cell["topic"] = title
        if not existing_presenter and block_presenter:
            cell["presenter"] = block_presenter
        filled += 1
        filled_details.append({"day": day_i, "label": title, "topic": title, "presenter": block_presenter})
        # Bubble up time_label if empty
        if not (row.get("time_label") or "").strip():
            row["time_label"] = _to_pretty_time(b.get("start_time") or "")

    # Persist
    await db.weekly_agendas.update_one(
        {"id": doc["id"]},
        {"$set": {"rows": rows, "updated_at": now_iso}},
    )
    doc["rows"] = rows
    doc["updated_at"] = now_iso

    return {
        "ok": True,
        "filled": filled,
        "skipped": skipped,
        "total_blocks": len(blocks),
        "filled_details": filled_details,
        "agenda": _scrub(doc),
    }


# ──────────────────────────────────────────────────────────────────────────
# Helper for the matcher UI: list all unique block titles in this office so
# the admin can pick from the dropdown when wiring "agenda row → schedule".
# ──────────────────────────────────────────────────────────────────────────
@router.get("/agenda/schedule-titles")
async def list_schedule_titles(request: Request, office: Optional[str] = None):
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Forbidden")
    office_id = _scope_office(user, office)
    if not office_id:
        return {"titles": []}
    titles = await db.schedule_blocks.distinct("title", {"office_id": office_id, "audience": {"$ne": "personal"}})
    titles = sorted([t for t in titles if t and isinstance(t, str)])
    return {"titles": titles}



# ──────────────────────────────────────────────────────────────────────────
# POST /api/agenda/scan — admin uploads a photo of the handwritten weekly
# planner sheet; we run it through Gemini Vision and return a parsed agenda
# (themes + stats + rows). The frontend then shows a per-field review modal
# so the admin can pick which scanned values to apply to the current draft.
# Auth: admin only.
# ──────────────────────────────────────────────────────────────────────────
SCAN_PROMPT_BASE = """You are extracting structured data from a photograph of a handwritten weekly planner sheet for a sales team office.

The sheet has these areas:
1) **Top-left themes column** with rows labelled: SHADOW EXPECTATION, LEADERS THEME, OFFICE THEME, CUSTOMER SERVICE, CONCENTRATION, NEWS, SOCIAL.
2) **Top-right stats column** — extract these three values: WEEKLY GOAL (sales goal number), PROMOTIONS, PERSONAL RECRUITS.
3) **Main grid** with day columns Monday..Saturday (sometimes Sunday). Transcribe EVERY ROW you see along the left margin **with the exact label as written on the sheet** — do NOT skip rows, do NOT remap labels. Each cell may have a topic, a presenter name (often UPPERCASE), or both ("PRESENTER - topic", "topic. PRESENTER", just a name like "SAM", or just a topic like "GOALS").

For reference, this office uses these row/block titles in their digital schedule (you do NOT have to map to them — just transcribe what you see and the user will map it after):
{row_labels}

Return a STRICT JSON object (no markdown, no commentary) matching this exact schema:
{{
  "themes": {{
    "expectations_1": "string (1st 'Shadow Expectation' line if present)",
    "expectations_2": "string (2nd 'Shadow Expectation' line if present)",
    "leaders": "string",
    "topic_theme": "string (Office Theme on the sheet)",
    "customer_service_theme": "string (Customer Service)",
    "competition": "string (any 'Competition this week' note, may be empty)",
    "concentration": "string",
    "news": "string",
    "social": "string"
  }},
  "stats": {{
    "weekly_goal": "string (Sales / Weekly Goal — number or short text)",
    "promotions": "string",
    "personal_recruits": "string"
  }},
  "rows": [
    {{
      "label": "<the LITERAL row label as written on the sheet — preserve casing>",
      "cells": {{
        "Mon": {{ "topic": "string", "presenter": "string" }},
        "Tue": {{ "topic": "string", "presenter": "string" }},
        "Wed": {{ "topic": "string", "presenter": "string" }},
        "Thu": {{ "topic": "string", "presenter": "string" }},
        "Fri": {{ "topic": "string", "presenter": "string" }},
        "Sat": {{ "topic": "string", "presenter": "string" }}
      }}
    }}
  ]
}}

Rules:
- Transcribe row labels verbatim — do not rename "Interviews" to "Appointments", do not change casing. The user will map labels themselves.
- If only a name is written (e.g. "SAM"), put it in `presenter` and leave `topic` empty.
- If only a topic is written (e.g. "GOALS"), put it in `topic` and leave `presenter` empty.
- If both are present (e.g. "SAM - GAME"), `presenter` = "SAM" and `topic` = "GAME".
- Trim whitespace; preserve original casing for names; keep topic short (≤40 chars) — do NOT invent content not on the sheet.
- For days/cells that are blank, use empty strings (do not omit the cell).
- Output ONLY the JSON object — no prose, no fences."""


# ──────────────────────────────────────────────────────────────────────────
# Per-office persisted mappings: raw_label (what the OCR transcribed) →
# canonical_label (the office's actual block / Plan row label the admin
# chose last time). Stored in collection `agenda_scan_mappings` with
# unique compound key (office_id, raw_key) where raw_key is lower-cased.
# ──────────────────────────────────────────────────────────────────────────

async def _load_scan_mappings(office_id: str) -> dict:
    if not office_id:
        return {}
    out: dict = {}
    try:
        async for d in db.agenda_scan_mappings.find(
            {"office_id": office_id},
            {"_id": 0, "raw_key": 1, "target_label": 1},
        ):
            rk = (d.get("raw_key") or "").strip().lower()
            tl = (d.get("target_label") or "").strip()
            if rk and tl:
                out[rk] = tl
    except Exception:
        pass
    return out


def _suggest_target_label(raw_label: str, allowed_labels: list, saved_map: dict) -> tuple:
    """Suggest a canonical Plan row for an OCR-transcribed raw label.

    Resolution order:
      1. Saved mapping (admin previously chose this for the same raw_key)
      2. Case-insensitive exact match against allowed_labels
      3. Alias table (_ROW_ALIASES) — handles legacy "Sectors" / "News and Bells"
      4. Substring containment (forbids the "Leaders" trap by requiring the
         shorter string to be a whole word match, length ≥ 4)

    Returns (suggested_label, score 0-100).
    """
    raw = (raw_label or "").strip()
    if not raw:
        return None, 0
    rk = raw.lower()

    # 1) Saved mapping
    if rk in saved_map:
        if saved_map[rk] in allowed_labels:
            return saved_map[rk], 100

    # 2) Exact match (case-insensitive)
    lower_to_canonical = {l.lower(): l for l in allowed_labels if l}
    if rk in lower_to_canonical:
        return lower_to_canonical[rk], 95

    # 3) Alias table
    for std, aliases in _ROW_ALIASES.items():
        if rk == std.lower() or rk in aliases:
            std_canon = lower_to_canonical.get(std.lower())
            if std_canon:
                return std_canon, 70
            # Look for an allowed label that aliases to the same std
            for lbl in allowed_labels:
                if lbl.lower() == std.lower():
                    return lbl, 65

    # 4) Substring (whole-word, length ≥ 4) — safe approximation
    raw_tokens = set(t for t in rk.replace("&", " ").replace("/", " ").split() if len(t) >= 4)
    best_label, best_overlap = None, 0
    for lbl in allowed_labels:
        lbl_tokens = set(t for t in lbl.lower().replace("&", " ").replace("/", " ").split() if len(t) >= 4)
        overlap = len(raw_tokens & lbl_tokens)
        if overlap > best_overlap:
            best_overlap = overlap
            best_label = lbl
    if best_label and best_overlap >= 1:
        return best_label, 40 + min(best_overlap, 3) * 10

    return None, 0


def _normalize_scan_payload(parsed: dict, allowed_labels: list, saved_map: dict) -> dict:
    """Coerce the LLM output into the shape our agenda editor expects.

    Each scanned row keeps its `raw_label` (what Gemini transcribed) and
    gains a `suggested_label` (best-guess canonical from `allowed_labels`)
    plus a `score` 0-100 so the review UI can highlight low-confidence
    matches with a yellow "Unmapped" pill. The admin chooses the final
    mapping in the AgendaScanReviewSheet — see Issue #2.
    """
    out_themes = {}
    raw_themes = parsed.get("themes") or {}
    for k in DEFAULT_THEMES.keys():
        v = raw_themes.get(k)
        out_themes[k] = (v or "").strip() if isinstance(v, str) else ""

    out_stats = {}
    raw_stats = parsed.get("stats") or {}
    for k in DEFAULT_STATS.keys():
        v = raw_stats.get(k)
        if v is None:
            out_stats[k] = ""
        elif isinstance(v, (int, float)):
            out_stats[k] = str(v)
        else:
            out_stats[k] = (v or "").strip() if isinstance(v, str) else ""

    DAY_KEYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    out_rows = []
    for r in (parsed.get("rows") or []):
        if not isinstance(r, dict):
            continue
        raw_label = (r.get("label") or "").strip()
        if not raw_label:
            continue
        cells_raw = r.get("cells") or {}
        cells = []
        for di, dk in enumerate(DAY_KEYS):
            c = cells_raw.get(dk) or {}
            cells.append({
                "day": di,
                "topic": (c.get("topic") or "").strip() if isinstance(c.get("topic"), str) else "",
                "presenter": (c.get("presenter") or "").strip() if isinstance(c.get("presenter"), str) else "",
            })
        # Skip purely-empty rows
        if not any((c["topic"] or c["presenter"]) for c in cells):
            continue
        suggested, score = _suggest_target_label(raw_label, allowed_labels, saved_map)
        out_rows.append({
            "raw_label": raw_label,
            "suggested_label": suggested,        # may be None
            "score": int(score),                 # 0..100 (0 = no idea)
            "cells": cells,
            # `label` retained for backward-compat with the apply path —
            # equals suggested_label when present, else raw_label.
            "label": suggested or raw_label,
        })
    return {
        "themes": out_themes,
        "stats": out_stats,
        "rows": out_rows,
        "allowed_labels": allowed_labels,
    }


# ──────────────────────────────────────────────────────────────────────────
# POST /api/agenda/scan-mappings — persist the admin's chosen scanned-label
# → block mappings so future scans auto-resolve to the same target.
# Body: { office_id?, mappings: { "<raw_label>": "<target_label>", ... } }
# An empty target_label REMOVES the saved mapping (admin chose Skip).
# ──────────────────────────────────────────────────────────────────────────
@router.post("/agenda/scan-mappings")
async def save_scan_mappings(request: Request):
    admin = await require_admin(request)
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    office_id = _scope_office_write(admin, body.get("office_id"))
    if not office_id:
        raise HTTPException(status_code=400, detail="office_id required")
    mappings = body.get("mappings") or {}
    if not isinstance(mappings, dict):
        raise HTTPException(status_code=400, detail="mappings must be an object")

    saved = 0
    deleted = 0
    for raw_label, target_label in mappings.items():
        rk = (str(raw_label) or "").strip().lower()
        if not rk:
            continue
        tl = (str(target_label) or "").strip()
        if not tl:
            await db.agenda_scan_mappings.delete_one({"office_id": office_id, "raw_key": rk})
            deleted += 1
            continue
        await db.agenda_scan_mappings.update_one(
            {"office_id": office_id, "raw_key": rk},
            {"$set": {
                "office_id": office_id,
                "raw_key": rk,
                "raw_label": str(raw_label).strip(),
                "target_label": tl,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "updated_by": admin.get("id"),
            }},
            upsert=True,
        )
        saved += 1
    return {"ok": True, "saved": saved, "deleted": deleted}


@router.get("/agenda/scan-mappings")
async def list_scan_mappings(request: Request, office: Optional[str] = None):
    admin = await require_admin(request)
    office_id = _scope_office(admin, office)
    saved = await _load_scan_mappings(office_id)
    return {"office_id": office_id, "mappings": saved, "count": len(saved)}


@router.post("/agenda/scan")
async def scan_agenda_image(request: Request, file: UploadFile = File(...), office: Optional[str] = None):
    """Accept a photo of the handwritten weekly planner and return a parsed
    agenda payload. Admin only — does NOT save anything; the frontend shows
    a review modal and the admin chooses which fields to apply."""
    admin = await require_admin(request)
    # Read + size-cap (5 MB) to keep request times reasonable
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 12MB)")
    mime = (file.content_type or "").lower()
    if mime not in ("image/jpeg", "image/png", "image/webp", "image/jpg"):
        mime = "image/jpeg"

    # Downscale + recompress to keep BOTH request size and Gemini processing
    # time reasonable. The deployed Kubernetes ingress kills requests at ~60s,
    # so we must stay well under that. Target: longest side 1200px, JPEG
    # quality 75 — handwriting is still very legible and the payload drops
    # enough to cut end-to-end time ~30-40%.
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(raw))
        # HEIC support is registered via pillow_heif side-effects; fall back
        # to RGB so JPEG encoding is always safe.
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        max_side = 1200
        w, h = img.size
        scale = min(1.0, max_side / max(w, h))
        if scale < 1.0:
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=75, optimize=True)
        raw = buf.getvalue()
        mime = "image/jpeg"
    except Exception as ex:
        # If PIL fails, send the original bytes — Gemini will still try.
        print(f"[agenda/scan] image preprocess skipped: {ex}")

    b64 = base64.b64encode(raw).decode("ascii")

    from core.llm_keys import anthropic_api_key
    api_key = anthropic_api_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="LLM key not configured")

    # ── Build the office's allowed row-label set ───────────────────────────
    # The Plan rows are derived from schedule_blocks (one per unique title).
    # We also fold in any custom labels the admin already saved on the
    # current week's draft, so OCR results never invent new rows that
    # aren't already on the user's plan/schedule.
    office_id = _scope_office(admin, office)
    allowed_labels: list = []
    seen_lower: set = set()

    # 1) From schedule blocks (primary source)
    try:
        block_titles = await db.schedule_blocks.distinct("title", {"office_id": office_id, "audience": {"$ne": "personal"}})
        for t in (block_titles or []):
            if t and isinstance(t, str):
                key = t.strip().lower()
                if key and key not in seen_lower:
                    seen_lower.add(key)
                    allowed_labels.append(t.strip())
    except Exception:
        pass

    # 2) From any week's saved Plan rows (fallback for offices that haven't
    #    populated schedule_blocks yet, OR include manually-typed labels).
    try:
        async for d in db.weekly_agendas.find({"office_id": office_id}, {"_id": 0, "rows.label": 1}):
            for r in (d.get("rows") or []):
                lbl = (r.get("label") or "").strip()
                if not lbl:
                    continue
                key = lbl.lower()
                if key not in seen_lower:
                    seen_lower.add(key)
                    allowed_labels.append(lbl)
    except Exception:
        pass

    # 3) Final fallback — STANDARD_ROW_LABELS so legacy offices still work
    if not allowed_labels:
        allowed_labels = list(STANDARD_ROW_LABELS)

    # Load admin's previously-saved scanned-label → block mappings so the
    # review UI can pre-pick the right target row for a known raw_label.
    saved_map = await _load_scan_mappings(office_id)

    take_ai_quota(admin)  # per-person hourly AI cap (core/rate_limit.py)
    # Send to the vision model via emergentintegrations
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"LLM library missing: {ex}")

    chat = LlmChat(
        api_key=api_key,
        session_id=f"agenda-scan-{uuid.uuid4().hex[:10]}",
        system_message=(
            "You are an expert OCR/parser. Extract structured JSON from photos "
            "of handwritten weekly planner sheets. Always return valid JSON only."
        ),
    ).with_model("vision")

    prompt = SCAN_PROMPT_BASE.format(
        row_labels=", ".join(f'"{lbl}"' for lbl in allowed_labels),
    )
    msg = UserMessage(
        text=prompt,
        file_contents=[ImageContent(image_base64=b64)],
    )
    try:
        # Hard cap at 50s so we can return a clean 504 before the deployed
        # Kubernetes ingress (~60s) does it for us. If the lite model is
        # slow or OOM's, the caller gets a descriptive error instead of the
        # opaque ingress 504.
        import asyncio
        response = await asyncio.wait_for(chat.send_message(msg), timeout=50)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Vision model timed out. Try a smaller/clearer photo.")
    except Exception:
        logger.exception("agenda scan AI call failed")
        raise HTTPException(status_code=502, detail="The photo couldn't be read by the AI. Try again shortly.")

    text = response if isinstance(response, str) else str(response)

    # Strip code fences / leading prose if any
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    # Try to find the first '{' .. last '}'
    if not cleaned.startswith("{"):
        m = re.search(r"\{.*\}", cleaned, flags=re.S)
        if m:
            cleaned = m.group(0)

    try:
        parsed = json.loads(cleaned)
    except Exception as ex:
        # Surface a portion of the raw output to help debugging
        snippet = (text or "")[:400]
        raise HTTPException(status_code=502, detail=f"Could not parse model JSON: {ex}. Raw: {snippet}")

    normalized = _normalize_scan_payload(parsed, allowed_labels, saved_map)
    return {"ok": True, **normalized}
