"""Company-specific OwnerIQ settings — configured by env, discovered otherwise.

An OwnerIQ owner login can manage one or more "marketing companies" (in
practice: one per office). Each has a numeric `id` (used when creating teams)
and a `pin` (used to switch the session's active company, and stamped on every
KPI row as `mc_pin`). Nothing here is hard-coded for a particular company:

  OWNERIQ_MC_PINS       optional comma list of pins to sync. Unset → every
                        company the login can see (discovered via
                        GET /v2/marketing_companies and cached in Mongo).
  OWNERIQ_OFFICE_PINS   optional "Office Name=PIN,Other Office=PIN" map from
                        app offices to OwnerIQ companies. An office doc can
                        also carry its own `owneriq_pin` field (wins).
                        Unset → if there is exactly one company, every office
                        maps to it; otherwise offices are matched to
                        companies whose OwnerIQ name equals the office name.
  OWNERIQ_ROOT_USER_IDS optional comma list of OwnerIQ user ids that are
                        platform-wide root nodes (not an office owner) and
                        must be skipped when finding each office's owner.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from database import db

logger = logging.getLogger(__name__)

_META_ID = "companies"


def _csv(value: str | None) -> list[str]:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


def configured_pins() -> list[str]:
    return _csv(os.getenv("OWNERIQ_MC_PINS"))


def root_user_ids() -> set[str]:
    return set(_csv(os.getenv("OWNERIQ_ROOT_USER_IDS")))


def _office_pin_overrides() -> dict[str, str]:
    """lower(office name) → pin, from OWNERIQ_OFFICE_PINS."""
    out: dict[str, str] = {}
    for part in _csv(os.getenv("OWNERIQ_OFFICE_PINS")):
        if "=" not in part:
            continue
        name, pin = part.rsplit("=", 1)
        if name.strip() and pin.strip():
            out[name.strip().lower()] = pin.strip()
    return out


def parse_companies(payload: dict) -> list[dict]:
    """JSON:API /v2/marketing_companies body → [{id, pin, name}]."""
    out = []
    for c in (payload or {}).get("data") or []:
        at = c.get("attributes") or {}
        pin = str(at.get("pin") or "").strip()
        if not pin:
            continue
        out.append({"id": str(c.get("id") or ""), "pin": pin, "name": str(at.get("name") or "").strip()})
    return out


async def remember_companies(companies: list[dict]) -> None:
    """Cache the discovered companies so request paths without an OwnerIQ
    session (office scoping, the office switchers) can use them."""
    if not companies:
        return
    await db.owneriq_meta.update_one(
        {"_id": _META_ID},
        {"$set": {"companies": companies, "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )


async def known_companies(database=None) -> list[dict]:
    """Last discovered companies ([{id, pin, name}]), filtered to the
    configured pins when OWNERIQ_MC_PINS is set. Configured pins that were
    never discovered still appear (with no id/name)."""
    database = db if database is None else database
    doc = await database.owneriq_meta.find_one({"_id": _META_ID}) or {}
    companies = [c for c in (doc.get("companies") or []) if c.get("pin")]
    pins = configured_pins()
    if not pins:
        return companies
    by_pin = {c["pin"]: c for c in companies}
    return [by_pin.get(p) or {"id": "", "pin": p, "name": ""} for p in pins]


async def discover_companies(client, token: str, api_base: str, headers: dict) -> list[dict]:
    """Ask OwnerIQ which companies this login manages (and cache them)."""
    try:
        r = await client.get(
            f"{api_base}/v2/marketing_companies",
            headers={**headers, "authorization": f"Bearer {token}"},
        )
        if r.status_code != 200:
            logger.warning("OwnerIQ company discovery: HTTP %s", r.status_code)
            return []
        companies = parse_companies(r.json())
    except Exception as ex:
        logger.warning("OwnerIQ company discovery failed: %s", ex)
        return []
    await remember_companies(companies)
    return companies


async def pins_to_sync(client, token: str, api_base: str, headers: dict) -> list[str]:
    """OWNERIQ_MC_PINS if set, else every company the login can see."""
    pins = configured_pins()
    if pins:
        # Still refresh the cache so ids/names are known for these pins.
        await discover_companies(client, token, api_base, headers)
        return pins
    return [c["pin"] for c in await discover_companies(client, token, api_base, headers)]


def resolve_office_pin(office: dict | None, companies: list[dict],
                       overrides: dict[str, str] | None = None) -> str | None:
    """Pure mapping rule for one office doc (see module docstring)."""
    if not office:
        return None
    explicit = str(office.get("owneriq_pin") or "").strip()
    if explicit:
        return explicit
    name = str(office.get("name") or "").strip().lower()
    overrides = _office_pin_overrides() if overrides is None else overrides
    if name and name in overrides:
        return overrides[name]
    if len(companies) == 1:
        return companies[0]["pin"]
    match = [c["pin"] for c in companies if name and c.get("name", "").strip().lower() == name]
    return match[0] if len(match) == 1 else None


async def office_pin(office_id: str | None, database=None) -> str | None:
    """App office id → OwnerIQ company pin (None when it can't be resolved)."""
    if not office_id:
        return None
    database = db if database is None else database
    office = await database.offices.find_one({"id": office_id}, {"_id": 0, "name": 1, "owneriq_pin": 1})
    return resolve_office_pin(office, await known_companies(database))


async def office_pin_map(database=None) -> dict[str, str]:
    """{office id: pin} for every office that resolves."""
    database = db if database is None else database
    companies = await known_companies(database)
    overrides = _office_pin_overrides()
    out: dict[str, str] = {}
    async for o in database.offices.find({}, {"_id": 0, "id": 1, "name": 1, "owneriq_pin": 1}):
        pin = resolve_office_pin(o, companies, overrides)
        if o.get("id") and pin:
            out[o["id"]] = pin
    return out


async def company_id_for_pin(pin: str | None) -> str | None:
    """OwnerIQ marketing_company_id for a pin (needed to create teams)."""
    if not pin:
        return None
    for c in await known_companies():
        if c.get("pin") == pin and c.get("id"):
            return c["id"]
    return None
