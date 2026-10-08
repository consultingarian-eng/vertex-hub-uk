"""Quality — the charity's fundraising quality report, per BA (see core/quality).

  POST /api/quality/import   admin: load a month's report (tables from the
                             charity's Power BI) for the admin's office
  GET  /api/quality          the caller's view of a month: a BA sees their own
                             row; a coach sees themselves and everyone under
                             them; an admin sees the whole office. Every row
                             carries RAG colours from the report's own bands.

Stored in `quality_reports`, one document per (office_id, period "YYYY-MM").
BAs are matched to app users by badge number (users.amplifi_codes, badges,
OwnerIQ KPI rows), then by "First L" name.
"""
import re
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request

from auth import get_current_user, get_subtree_ids, require_admin
from core.quality import LABELS, OVERALL_COLUMNS, RAG, parse_report, rag
from database import db
from owneriq_sync import ID_LINKED

router = APIRouter()

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]


def _period_label(period: str) -> str:
    y, m = period.split("-")
    return f"{MONTHS[int(m) - 1]} {y}"


async def _badge_index(office_id: str) -> tuple[dict, dict]:
    """(badge -> user_id, 'first l' -> user_id) for the office's users."""
    by_badge: dict[str, str] = {}
    users = await db.users.find({"office_id": office_id, "deleted": {"$ne": True}},
                                {"name": 1, "amplifi_codes": 1}).to_list(5000)
    ids = {str(u["_id"]) for u in users}
    for u in users:
        for c in u.get("amplifi_codes") or []:
            by_badge.setdefault(str(c).strip().upper(), str(u["_id"]))
    async for b in db.badges.find({"user_id": {"$in": list(ids)}}, {"badge_number": 1, "user_id": 1}):
        by_badge.setdefault(str(b.get("badge_number") or "").strip().upper(), str(b["user_id"]))
    async for r in db.owneriq_kpis.find({"cg1_user_id": {"$in": list(ids)}, "badge_number": {"$nin": [None, ""]}, **ID_LINKED},
                                        {"badge_number": 1, "cg1_user_id": 1}):
        by_badge.setdefault(str(r["badge_number"]).strip().upper(), str(r["cg1_user_id"]))
    by_name: dict[str, str] = {}
    counts: dict[str, int] = {}
    for u in users:
        parts = str(u.get("name") or "").strip().split()
        if len(parts) >= 2:
            k = f"{parts[0].lower()} {parts[-1][0].lower()}"
            counts[k] = counts.get(k, 0) + 1
            by_name[k] = str(u["_id"])
    return by_badge, {k: v for k, v in by_name.items() if counts[k] == 1}


@router.post("/quality/import")
async def import_quality(request: Request):
    admin = await require_admin(request)
    body = await request.json()
    period = str(body.get("period") or "").strip()
    if not re.match(r"^\d{4}-(0[1-9]|1[0-2])$", period):
        raise HTTPException(status_code=400, detail="period must be YYYY-MM")
    pages = body.get("pages") or {}
    office_id = body.get("office_id") if admin.get("is_super_admin") and body.get("office_id") else admin.get("office_id")
    office = await db.offices.find_one({"id": office_id}, {"name": 1})
    if not office:
        raise HTTPException(status_code=400, detail="Office not found")
    parsed = parse_report(pages, body.get("office_label") or "Vertex Organisation")
    if not parsed["bas"]:
        raise HTTPException(status_code=400, detail="No BA rows found in the report tables")
    by_badge, by_name = await _badge_index(office_id)
    bas, unmatched = [], []
    for badge, ba in parsed["bas"].items():
        label = ba.get("label") or badge
        first_l = " ".join(label.replace(badge, "").split()[:1] + label.replace(badge, "").split()[-1:][:1]).lower()
        uid = by_badge.get(badge) or by_name.get(first_l)
        ba["user_id"] = uid
        bas.append(ba)
        if not uid:
            unmatched.append(label)
    now = datetime.now(timezone.utc).isoformat()
    await db.quality_reports.update_one(
        {"office_id": office_id, "period": period},
        {"$set": {"office_id": office_id, "period": period, "label": body.get("label") or _period_label(period),
                  "bas": bas, "office": parsed["office"], "weeks": parsed["weeks"],
                  "fail_reasons": parsed["fail_reasons"], "source": body.get("source") or "powerbi",
                  "imported_at": now, "imported_by": admin.get("id")}},
        upsert=True)
    return {"period": period, "bas": len(bas), "matched": len(bas) - len(unmatched), "unmatched": unmatched}


def _with_rag(metrics: dict) -> dict:
    return {k: {"value": v, "rag": rag(k, v)} for k, v in (metrics or {}).items()}


@router.get("/quality")
async def get_quality(request: Request, period: Optional[str] = None, office: Optional[str] = None):
    user = await get_current_user(request)
    office_id = office if (user.get("is_super_admin") and office) else user.get("office_id")
    periods = [d["period"] async for d in db.quality_reports.find({"office_id": office_id}, {"period": 1}).sort("period", -1)]
    base = {"periods": [{"period": p, "label": _period_label(p)} for p in periods],
            "columns": [{"key": k, "label": LABELS.get(k, h)} for k, h, _ in OVERALL_COLUMNS],
            "bands": RAG}
    if not periods:
        return {**base, "period": None}
    period = period if period in periods else periods[0]
    rep = await db.quality_reports.find_one({"office_id": office_id, "period": period}, {"_id": 0})
    uid = str(user.get("id"))
    role = user.get("role")
    if role == "admin":
        visible = None
    elif role == "leader":
        visible = set(await get_subtree_ids(uid))
    else:
        visible = {uid}
    ids = [ba["user_id"] for ba in rep["bas"] if ba.get("user_id")]
    names = {str(u["_id"]): u.get("name") async for u in db.users.find(
        {"_id": {"$in": [ObjectId(i) for i in ids if ObjectId.is_valid(i)]}}, {"name": 1})}
    rows, me = [], None
    for ba in rep["bas"]:
        if visible is not None and ba.get("user_id") not in visible:
            continue
        row = {"user_id": ba.get("user_id"), "name": names.get(ba.get("user_id")) or ba.get("label"),
               "badge": ba.get("badge"), "metrics": _with_rag(ba.get("metrics")),
               "weekly_call_rate": {w: {"value": v, "rag": rag("completed_call_rate", v)}
                                    for w, v in (ba.get("weekly_call_rate") or {}).items()},
               "fails": ba.get("fails"), "net_signups": ba.get("net_signups")}
        if ba.get("user_id") == uid:
            me = row
        rows.append(row)
    rows.sort(key=lambda r: -((r["metrics"].get("signups") or {}).get("value") or 0))
    return {**base, "period": period, "label": rep.get("label"), "imported_at": rep.get("imported_at"),
            "weeks": rep.get("weeks") or [], "me": me,
            "team": [r for r in rows if r is not me] if role in ("leader", "admin") else [],
            "office": _with_rag(rep.get("office")) if role == "admin" else None,
            "fail_reasons": rep.get("fail_reasons") if role == "admin" else None}
