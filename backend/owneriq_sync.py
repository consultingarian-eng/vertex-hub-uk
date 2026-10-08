"""OwnerIQ (Field IQ) → CG1 DataByte sync.

The field-sales tool ("Field IQ") has an owner-facing dashboard, OwnerIQ
(https://owner-iq.ai, API host set by OWNERIQ_API_BASE). With an owner login
we pull our own data the same way the browser does:

  1. POST /v3/owner/sessions  {"session": {"email", "password"}}
        → 200, body.data.attributes.auth_token   (a bearer token)
  2. GET  /v2/door_interaction_kpis
            ?between_dates=DD/MM/YYYY,DD/MM/YYYY&page=N&per_page=100&include=user
        header: Authorization: Bearer <auth_token>,  Accept: application/vnd.api+json
        → JSON:API rows: doors_knocked, spoken_to, pitches_commenced,
          pitches_closed, sales, points, date, mc_pin, badge_number
          + relationships.user.data.id  and  included[] users (full_name)

Rows are upserted into the `owneriq_kpis` collection keyed by the OwnerIQ row id
(idempotent — re-syncing updates changed figures instead of duplicating).

Each row is linked to a CG1 rep automatically:
  • primary:  OwnerIQ badge_number → db.badges.badge_number / users' badge numbers → user_id
  • (the OwnerIQ id stored on the account, users.owneriq_user_id, wins over both)
  • a full-name match is stored only as `cg1_suggested_user_id` (display hint);
    it never sets cg1_user_id, because people can rename themselves.

Credentials come from env (never hard-coded):
  OWNERIQ_EMAIL, OWNERIQ_PASSWORD, and optionally OWNERIQ_API_BASE.
Which marketing companies (offices) to sync: see owneriq_config.py.
"""
import os
import logging
import re
from datetime import datetime, timedelta, timezone

import httpx

from database import db

logger = logging.getLogger(__name__)

OWNERIQ_API_BASE = (os.getenv("OWNERIQ_API_BASE") or "https://us.owner-iq.ai").rstrip("/")
# An owner login can manage several marketing companies (offices). Data is
# scoped to ONE active company at a time (server-side session state), switched
# by a side-effect GET /v2/marketing_companies?mc_pin=<pin>. We sync each pin
# in turn per run — OWNERIQ_MC_PINS, or every company the login can see
# (owneriq_config.pins_to_sync).
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36"
# The DataByte "date" is the local field day, read in app time (core.app_time).
from core.app_time import APP_TZ


class OwnerIQError(RuntimeError):
    pass


def _creds() -> tuple[str, str]:
    email = (os.getenv("OWNERIQ_EMAIL") or "").strip()
    password = (os.getenv("OWNERIQ_PASSWORD") or "")
    if not email or not password:
        raise OwnerIQError(
            "OWNERIQ_EMAIL / OWNERIQ_PASSWORD not configured in environment"
        )
    return email, password


def _to_api_date(iso_date: str) -> str:
    """'2026-07-14' → '14/07/2026' (the format OwnerIQ's between_dates expects)."""
    return datetime.strptime(iso_date, "%Y-%m-%d").strftime("%d/%m/%Y")


async def _login(client: httpx.AsyncClient) -> str:
    email, password = _creds()
    r = await client.post(
        f"{OWNERIQ_API_BASE}/v3/owner/sessions",
        json={"session": {"email": email, "password": password}},
        headers={
            "accept": "*/*",
            "content-type": "application/json",
            "origin": "https://owner-iq.ai",
            "referer": "https://owner-iq.ai/",
            "user-agent": _UA,
        },
    )
    if r.status_code != 200:
        raise OwnerIQError(f"login failed: HTTP {r.status_code} {r.text[:200]}")
    try:
        token = r.json()["data"]["attributes"]["auth_token"]
    except Exception as ex:
        raise OwnerIQError(f"login response missing auth_token: {ex}")
    if not token:
        raise OwnerIQError("login succeeded but auth_token was empty")
    return token


async def _select_company(client: httpx.AsyncClient, token: str, pin: str) -> None:
    """Set the session's active marketing company (side-effect GET). After this,
    door_interaction_kpis returns that company's reps until switched again."""
    r = await client.get(
        f"{OWNERIQ_API_BASE}/v2/marketing_companies",
        params={"mc_pin": pin},
        headers={
            "accept": "application/vnd.api+json",
            "x-requested-with": "XMLHttpRequest",
            "origin": "https://owner-iq.ai",
            "user-agent": _UA,
            "authorization": f"Bearer {token}",
        },
    )
    if r.status_code != 200:
        raise OwnerIQError(f"select company {pin} failed: HTTP {r.status_code} {r.text[:200]}")


async def _fetch_kpis(client: httpx.AsyncClient, token: str, iso_from: str, iso_to: str) -> list[dict]:
    """Return normalized KPI rows for [iso_from, iso_to] (inclusive), all pages.

    The active company is whatever _select_company last set — call this once per
    marketing company (see _fetch_all_companies)."""
    headers = {
        "accept": "application/vnd.api+json",
        "x-requested-with": "XMLHttpRequest",
        "origin": "https://owner-iq.ai",
        "user-agent": _UA,
        "authorization": f"Bearer {token}",
    }
    between = f"{_to_api_date(iso_from)},{_to_api_date(iso_to)}"
    rows: list[dict] = []
    page = 1
    while True:
        r = await client.get(
            f"{OWNERIQ_API_BASE}/v2/door_interaction_kpis",
            params={
                "between_dates": between,
                "page": page,
                "per_page": 100,
                "include": "user",
                "sortColumn": "",
                "sortDirection": "",
            },
            headers=headers,
        )
        if r.status_code != 200:
            raise OwnerIQError(
                f"door_interaction_kpis page {page} failed: HTTP {r.status_code} {r.text[:200]}"
            )
        payload = r.json()
        # user id → full name, from the JSON:API `included` sideload
        names = {
            u["id"]: (u.get("attributes", {}) or {}).get("full_name")
            for u in payload.get("included", [])
            if u.get("type") == "users"
        }
        for item in payload.get("data", []):
            attr = item.get("attributes", {}) or {}
            rel = item.get("relationships", {}) or {}
            uid = (((rel.get("user") or {}).get("data")) or {}).get("id")
            cid = (((rel.get("campaign") or {}).get("data")) or {}).get("id")
            rows.append({
                "owneriq_id": str(item.get("id")),
                "date": attr.get("date"),
                "doors_knocked": attr.get("doors_knocked"),
                "spoken_to": attr.get("spoken_to"),
                "pitches_commenced": attr.get("pitches_commenced"),
                "pitches_closed": attr.get("pitches_closed"),
                "sales": attr.get("sales"),
                "points": attr.get("points"),
                "mc_pin": (str(attr["mc_pin"]) if attr.get("mc_pin") is not None else None),
                "badge_number": (attr.get("badge_number") or "").strip().upper() or None,
                "test_mode": bool(attr.get("test_mode")),
                "owneriq_user_id": uid,
                "rep_name": names.get(uid),
                "owneriq_created_at": attr.get("created_at"),
                "owneriq_updated_at": attr.get("updated_at"),
            })
        meta = payload.get("meta", {}) or {}
        total_pages = meta.get("total_pages") or 1
        if page >= total_pages:
            break
        page += 1
    return rows


def _api_headers() -> dict:
    return {
        "accept": "application/vnd.api+json",
        "x-requested-with": "XMLHttpRequest",
        "origin": "https://owner-iq.ai",
        "user-agent": _UA,
    }


async def company_pins(client: httpx.AsyncClient, token: str) -> list[str]:
    """Pins to walk this run: OWNERIQ_MC_PINS, else every company the login
    can see (discovered and cached by owneriq_config)."""
    from owneriq_config import pins_to_sync
    return await pins_to_sync(client, token, OWNERIQ_API_BASE, _api_headers())


async def _fetch_all_companies(client: httpx.AsyncClient, token: str, iso_from: str, iso_to: str) -> list[dict]:
    """Fetch KPI rows across every marketing company (office) we sync."""
    combined: dict[str, dict] = {}
    pins = await company_pins(client, token)
    if not pins:
        # Nothing configured and discovery found nothing: read whatever the
        # session's default company is (a single-company login).
        for row in await _fetch_kpis(client, token, iso_from, iso_to):
            combined[row["owneriq_id"]] = row
        return list(combined.values())
    for pin in pins:
        await _select_company(client, token, pin)
        for row in await _fetch_kpis(client, token, iso_from, iso_to):
            combined[row["owneriq_id"]] = row  # owneriq row ids are globally unique
    return list(combined.values())


async def _build_rep_resolvers() -> tuple[dict, dict]:
    """Return (badge_number → user_id, lower(name) → user_id) maps from CG1.

    When a badge/name maps to more than one CG1 user — e.g. a rep who was binned
    and later re-added (an old deleted record + a new active one share the same
    badge) — the ACTIVE record wins, so linking points at the live account (and
    reconcile doesn't wrongly deactivate a returned rep)."""
    # Which CG1 users are deleted/inactive (so active can override them).
    deleted_ids: set[str] = set()
    async for u in db.users.find({"$or": [{"deleted": True}, {"is_active": False}]}, {"_id": 1}):
        deleted_ids.add(str(u["_id"]))

    by_badge: dict[str, str] = {}
    by_name: dict[str, str] = {}

    def _put(mapping: dict, key: str, uid: str):
        if not key or not uid:
            return
        cur = mapping.get(key)
        # take it if unset, or if the current mapping is deleted and this isn't.
        if cur is None or (cur in deleted_ids and uid not in deleted_ids):
            mapping[key] = uid

    async for b in db.badges.find({}, {"_id": 0, "badge_number": 1, "user_id": 1}):
        _put(by_badge, (b.get("badge_number") or "").strip().upper(), b.get("user_id"))
    # Users store no separate `id` field — id = str(_id) at read time
    # (auth.py) == badges.user_id == hierarchy subtree ids. The badge numbers
    # on the user profile (`amplifi_codes`, historical name) count too.
    # Whitespace-normalise names.
    active_by_name: dict[str, set] = {}
    async for u in db.users.find({}, {"_id": 1, "name": 1, "amplifi_codes": 1}):
        uid = str(u["_id"])
        key = _norm_name(u.get("name"))
        _put(by_name, key, uid)
        if key and uid not in deleted_ids:
            active_by_name.setdefault(key, set()).add(uid)
        for c in (u.get("amplifi_codes") or []):
            _put(by_badge, str(c or "").strip().upper(), uid)
    # A name two live accounts share is ambiguous: it links nobody (badges and
    # stored ids still do). Otherwise anyone could take a colleague's name and
    # inherit their OwnerIQ rows on the next sync.
    for key, ids in active_by_name.items():
        if len(ids) > 1:
            by_name.pop(key, None)
    return by_badge, by_name


_ASCII_ID = re.compile(r"[0-9]{1,20}")


def is_oid(value) -> bool:
    """True for an OwnerIQ id: 1-20 ASCII digits and nothing else. (str.isdigit
    and \\d also accept other scripts' digits and superscripts.)"""
    return isinstance(value, str) and _ASCII_ID.fullmatch(value) is not None


# Every owneriq_kpis lookup that decides access or picks an OwnerIQ write
# target adds this, on top of the sync never storing a name match as a link:
# rows written before that rule may still carry one.
ID_LINKED = {"cg1_matched_by": {"$ne": "name"}}


async def retire_name_links() -> int:
    """Turn KPI rows linked by display name (older versions did this) into
    display-only hints, so they stop granting access. Idempotent."""
    n = 0
    async for r in db.owneriq_kpis.find({"cg1_matched_by": "name"}, {"_id": 1, "cg1_user_id": 1}):
        await db.owneriq_kpis.update_one(
            {"_id": r["_id"]},
            {"$set": {"cg1_user_id": None, "cg1_matched_by": None,
                      "cg1_suggested_user_id": r.get("cg1_user_id")}},
        )
        n += 1
    if n:
        logger.info("OwnerIQ: %d KPI rows were linked by name only; kept as display hints", n)
    return n


def _norm_name(s) -> str:
    return " ".join((s or "").split()).lower()


async def sync_owneriq(iso_from: str | None = None, iso_to: str | None = None) -> dict:
    """Pull DataByte KPIs for a date range and upsert into `owneriq_kpis`.

    Dates are ISO 'YYYY-MM-DD'. Defaults to a rolling window of yesterday+today
    (app time), which re-captures same-day corrections OwnerIQ makes to figures.
    Returns a summary dict.
    """
    today = datetime.now(APP_TZ).date()
    iso_to = iso_to or today.isoformat()
    iso_from = iso_from or (today - timedelta(days=1)).isoformat()

    synced_at = datetime.now(timezone.utc).isoformat()
    async with httpx.AsyncClient(timeout=45.0) as client:
        token = await _login(client)
        rows = await _fetch_all_companies(client, token, iso_from, iso_to)

    await retire_name_links()
    by_badge, by_name = await _build_rep_resolvers()
    # The OwnerIQ account id each user was linked to (owneriq_performance's
    # roster email/badge link) is the most precise key of all.
    by_oid = {str(u["owneriq_user_id"]): str(u["_id"]) async for u in db.users.find(
        {"owneriq_user_id": {"$ne": None}, "deleted": {"$ne": True}}, {"owneriq_user_id": 1})}
    matched = 0
    for row in rows:
        cg1_user_id, matched_by, suggested = None, None, None
        bn = row.get("badge_number")
        nm = _norm_name(row.get("rep_name"))
        if str(row.get("owneriq_user_id") or "") in by_oid:
            cg1_user_id, matched_by = by_oid[str(row["owneriq_user_id"])], "owneriq_id"
        elif bn and bn in by_badge:
            cg1_user_id, matched_by = by_badge[bn], "badge"
        elif nm and nm in by_name:
            # A name is only a hint (people can rename themselves): it is
            # stored for display and never becomes the link that decides who
            # sees or acts on this rep's data. Link by badge or OwnerIQ id.
            suggested = by_name[nm]
        if cg1_user_id:
            matched += 1
        row["cg1_user_id"] = cg1_user_id
        row["cg1_matched_by"] = matched_by
        row["cg1_suggested_user_id"] = suggested
        row["synced_at"] = synced_at
        await db.owneriq_kpis.update_one(
            {"_id": row["owneriq_id"]},
            {"$set": row, "$setOnInsert": {"first_seen_at": synced_at}},
            upsert=True,
        )

    # Record the last-sync heartbeat for the status endpoint / UI.
    summary = {
        "ok": True,
        "range": {"from": iso_from, "to": iso_to},
        "rows_synced": len(rows),
        "reps_matched": matched,
        "reps_unmatched": len(rows) - matched,
        "synced_at": synced_at,
    }
    await db.owneriq_sync_state.update_one(
        {"_id": "last"}, {"$set": summary}, upsert=True
    )
    logger.info(
        "OwnerIQ sync %s→%s: %d rows, %d matched, %d unmatched",
        iso_from, iso_to, len(rows), matched, len(rows) - matched,
    )
    return summary


### ── Aggregation engine (pure) ──────────────────────────────────────────
# Shared by the Field KPIs tab (self / team / office views) and the team-plan
# average integration. Groups raw per-rep-per-day rows into per-rep totals and
# per-day averages, computes group totals/averages with individual include-
# exclude + automatic zero-day dropping, and the reverse "ratios to one sale".

METRICS = ["doors_knocked", "spoken_to", "pitches_commenced", "pitches_closed", "sales", "points"]
# For "to get one sale you need X ...", points isn't a funnel input.
RATIO_METRICS = ["doors_knocked", "spoken_to", "pitches_commenced", "pitches_closed"]


def _rep_key(row: dict) -> str:
    """Canonical per-rep grouping key: badge number first (CG1's canonical id)."""
    return row.get("badge_number") or row.get("owneriq_user_id") or (row.get("rep_name") or "?")


def _is_zero_day(row: dict) -> bool:
    return not any((row.get(m) or 0) for m in ("doors_knocked", "spoken_to", "pitches_commenced", "pitches_closed", "sales"))


def aggregate_rows(rows: list[dict], exclude_keys: set[str] | None = None, include_zero: bool = False) -> dict:
    """Group raw KPI rows into per-rep + group totals / averages / ratios.

    exclude_keys: rep keys (badge numbers) to drop from the GROUP average/ratios
                  (they still appear in the per-rep list, flagged excluded).
    include_zero: when False, reps whose range totals are all zero are treated
                  as "off that day" and dropped from the group average/ratios.
    """
    exclude_keys = exclude_keys or set()
    reps: dict[str, dict] = {}
    for row in rows:
        k = _rep_key(row)
        r = reps.get(k)
        if not r:
            r = reps[k] = {
                "key": k,
                "badge_number": row.get("badge_number"),
                "rep_name": row.get("rep_name"),
                "cg1_user_id": row.get("cg1_user_id"),
                "owneriq_user_id": row.get("owneriq_user_id"),
                "mc_pin": row.get("mc_pin"),
                "active_days": 0,
                "totals": {m: 0 for m in METRICS},
            }
        # keep the most recent name/link we see
        if row.get("rep_name"):
            r["rep_name"] = row["rep_name"]
        if row.get("cg1_user_id"):
            r["cg1_user_id"] = row["cg1_user_id"]
        for m in METRICS:
            r["totals"][m] += (row.get(m) or 0)
        if not _is_zero_day(row):
            r["active_days"] += 1

    rep_list = []
    for r in reps.values():
        zero = not any(r["totals"][m] for m in ("doors_knocked", "spoken_to", "pitches_commenced", "pitches_closed", "sales"))
        days = r["active_days"] or (0 if zero else 1)
        r["zero"] = zero
        r["avg_per_day"] = {m: (round(r["totals"][m] / days, 2) if days else 0) for m in METRICS}
        r["excluded"] = (r["key"] in exclude_keys) or (zero and not include_zero)
        rep_list.append(r)
    rep_list.sort(key=lambda r: r["totals"]["points"], reverse=True)

    included = [r for r in rep_list if not r["excluded"]]
    group_totals = {m: sum(r["totals"][m] for r in included) for m in METRICS}
    n = len(included)
    total_active_rep_days = sum((r["active_days"] or 0) for r in included)

    avg_per_rep = {m: (round(group_totals[m] / n, 2) if n else 0) for m in METRICS}
    avg_per_rep_day = {
        m: (round(group_totals[m] / total_active_rep_days, 2) if total_active_rep_days else 0)
        for m in METRICS
    }
    sales = group_totals["sales"]
    ratios_to_one_sale = {
        m: (round(group_totals[m] / sales, 2) if sales else None) for m in RATIO_METRICS
    }

    return {
        "reps": rep_list,
        "included_count": n,
        "excluded_count": len(rep_list) - n,
        "group_totals": group_totals,
        "avg_per_rep": avg_per_rep,          # average total per rep over the range
        "avg_per_rep_day": avg_per_rep_day,  # average per rep per active day (planner figure)
        "ratios_to_one_sale": ratios_to_one_sale,
    }


async def scheduler_tick() -> None:
    """Hourly job entrypoint — swallow errors so the scheduler keeps running."""
    if not os.getenv("OWNERIQ_EMAIL") or not os.getenv("OWNERIQ_PASSWORD"):
        logger.info("OwnerIQ sync skipped: OWNERIQ_EMAIL/OWNERIQ_PASSWORD not set")
        return
    try:
        await sync_owneriq()
    except Exception as ex:
        logger.error("OwnerIQ scheduler tick failed: %s", ex)
        await db.owneriq_sync_state.update_one(
            {"_id": "last"},
            {"$set": {
                "ok": False,
                "error": str(ex)[:300],
                "synced_at": datetime.now(timezone.utc).isoformat(),
            }},
            upsert=True,
        )
