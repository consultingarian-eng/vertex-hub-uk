"""AI performance reports — collate a BA's (or a team's) Field KPIs and Bells
attendance into one structured payload, then let Claude write the narrative
on top.

Design rule: numbers are computed here (deterministic, auditable); the LLM only
writes analysis over the numbers — it never invents stats.

Data sources (both already in the app):
  • Field KPIs  → owneriq_kpis        (doors/spoken/pitches/sales, badge-linked)
  • Bells       → bells_entries       (days worked, sales, piece avg per week)
Join key across both = user id (str(_id)).
"""
import os
import logging
from datetime import datetime, timedelta

from database import db
from owneriq_sync import ID_LINKED, aggregate_rows

logger = logging.getLogger(__name__)

from core.app_time import APP_TZ, uk_date
from core.brand import BRITISH_ENGLISH, SELF_EMPLOYED_TERMS

PERIOD_DAYS = {"week": 7, "month": 30, "quarter": 90}


def period_range(period: str, from_date: str | None = None, to_date: str | None = None) -> tuple[str, str]:
    """Resolve a period label (or explicit dates) to (from_iso, to_iso)."""
    if from_date and to_date:
        return from_date, to_date
    today = datetime.now(APP_TZ).date()
    days = PERIOD_DAYS.get(period, 30)
    return (today - timedelta(days=days - 1)).isoformat(), today.isoformat()


def resolve_period(period: dict) -> tuple[str, str, str]:
    """Resolve a parsed period dict → (from_iso, to_iso, label). Supports a
    calendar month ("July"), an explicit range, or rolling week/month/quarter."""
    import calendar
    from datetime import date
    today = datetime.now(APP_TZ).date()
    kind = (period or {}).get("kind") or "month"
    if kind == "calendar_month":
        month = int((period or {}).get("month") or today.month)
        year = int((period or {}).get("year") or today.year)
        month = min(max(month, 1), 12)
        last = calendar.monthrange(year, month)[1]
        f, t = date(year, month, 1), date(year, month, last)
        if t > today:
            t = today
        return f.isoformat(), t.isoformat(), f"{calendar.month_name[month]} {year}"
    if kind == "range" and (period or {}).get("from") and (period or {}).get("to"):
        return period["from"], period["to"], f"{uk_date(period['from'])} → {uk_date(period['to'])}"
    days = PERIOD_DAYS.get(kind, 30)
    label = {"week": "last 7 days", "month": "last 30 days", "quarter": "last 90 days"}.get(kind, "last 30 days")
    return (today - timedelta(days=days - 1)).isoformat(), today.isoformat(), label


async def parse_intent(text: str) -> dict:
    """LLM: free-text request → structured intent. Numbers/ids are NEVER taken
    from the model — only {scope, name, period}; code resolves the rest."""
    from core.llm_keys import anthropic_api_key
    api_key = anthropic_api_key()
    if not api_key:
        return {}
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
    except Exception:
        return {}
    today = datetime.now(APP_TZ).date().isoformat()
    system = (
        "You extract a report request into JSON. Output ONLY a JSON object, no prose. "
        f"Today is {today}. Schema: {{\"scope\": \"individual\"|\"team\", \"name\": string, "
        "\"period\": {\"kind\": \"calendar_month\"|\"week\"|\"month\"|\"quarter\"|\"range\", "
        "\"month\": 1-12, \"year\": YYYY, \"from\": \"YYYY-MM-DD\", \"to\": \"YYYY-MM-DD\"}}. "
        "scope='team' if they mention a team/crew/office or 'team X'; else 'individual'. "
        "name = the person or team name exactly as written (strip the word 'team'). "
        "For a month name like 'July' use kind=calendar_month with that month and the most "
        "recent past/current year. 'this month'→calendar_month current; 'last week'→week; "
        "'this quarter'→quarter. Default period kind=month if unspecified."
    )
    try:
        chat = LlmChat(api_key=api_key, session_id=f"intent-{hash(text) & 0xffff}",
                       system_message=system).with_model("anthropic")
        raw = await chat.send_message(UserMessage(text=text)) or ""
    except Exception as e:
        logger.error("intent parse failed: %s", e)
        return {}
    import json, re
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except Exception:
        return {}


async def _names_for(user_ids: list[str]) -> dict[str, str]:
    from bson import ObjectId
    out: dict[str, str] = {}
    oids = []
    for u in user_ids:
        try:
            oids.append(ObjectId(u))
        except Exception:
            pass
    async for u in db.users.find({"_id": {"$in": oids}}, {"_id": 1, "name": 1}):
        out[str(u["_id"])] = u.get("name") or "Unknown"
    return out


async def field_summary(user_ids: list[str], iso_from: str, iso_to: str) -> dict:
    """Field KPI totals/averages/ratios + per-rep, for the given CG1 users."""
    rows = await db.owneriq_kpis.find(
        {"date": {"$gte": iso_from, "$lte": iso_to}, "cg1_user_id": {"$in": user_ids}, **ID_LINKED},
        {"_id": 0},
    ).to_list(length=20000)
    agg = aggregate_rows(rows, include_zero=False)
    return {
        "totals": agg["group_totals"],
        "avg_per_rep_day": agg["avg_per_rep_day"],
        "ratios_to_one_sale": agg["ratios_to_one_sale"],
        "active_reps": agg["included_count"],
        "reps": [
            {"name": r.get("rep_name"), "badge": r.get("badge_number"), "cg1_user_id": r.get("cg1_user_id"),
             "totals": r["totals"], "avg_per_day": r["avg_per_day"], "active_days": r["active_days"]}
            for r in agg["reps"]
        ],
    }


async def bells_summary(user_id: str, iso_from: str, iso_to: str) -> dict:
    """Attendance + sales from the Bells sheet for the weeks in range."""
    try:
        from routes.bells import _is_in_day, _safe_num
    except Exception:
        _is_in_day = lambda d: (d or {}).get("status") == "in"  # noqa: E731
        _safe_num = lambda v: float(v) if isinstance(v, (int, float)) else 0.0  # noqa: E731

    weeks = []
    total_days = total_sales = total_mem = 0
    cur = db.bells_entries.find(
        {"user_id": user_id, "week_ending": {"$gte": iso_from, "$lte": iso_to}},
        {"_id": 0, "week_ending": 1, "days": 1},
    )
    async for e in cur:
        days = e.get("days") or []
        dw = sum(1 for d in days if _is_in_day(d))
        sales = sum(int(_safe_num(d.get("over30")) + _safe_num(d.get("under30"))) for d in days if _is_in_day(d))
        mem = sum(int(_safe_num(d.get("memberships"))) for d in days)
        weeks.append({
            "week_ending": e.get("week_ending"),
            "days_worked": dw,
            "sales": sales,
            "memberships": mem,
            "piece_avg": round(sales / dw, 2) if dw else 0.0,
        })
        total_days += dw
        total_sales += sales
        total_mem += mem
    weeks.sort(key=lambda w: w["week_ending"])
    n = len(weeks)
    return {
        "weeks_counted": n,
        "total_days_worked": total_days,
        "avg_days_per_week": round(total_days / n, 1) if n else 0.0,
        "total_sales": total_sales,
        "avg_sales_per_week": round(total_sales / n, 1) if n else 0.0,
        "piece_avg": round(total_sales / total_days, 2) if total_days else 0.0,
        "memberships": total_mem,
        "weeks": weeks,
    }


async def build_individual(user_id: str, iso_from: str, iso_to: str) -> dict:
    names = await _names_for([user_id])
    field = await field_summary([user_id], iso_from, iso_to)
    bells = await bells_summary(user_id, iso_from, iso_to)
    out = {
        "scope": "individual",
        "name": names.get(user_id, "Unknown"),
        "user_id": user_id,
        "range": {"from": iso_from, "to": iso_to},
        "field": field,
        "bells": bells,
    }
    # Sales Development Path — level + the exec-requested pre-30/post-30-day
    # average-earnings split, read from the stored evaluator doc (no
    # recompute here; the write hooks keep it fresh). Absent while the
    # feature is dark for this office.
    sp = await db.sales_path.find_one(
        {"user_id": user_id},
        {"_id": 0, "level": 1, "level_name": 1, "green_weeks": 1, "form": 1, "ramp": 1},
    )
    if sp:
        ramp = sp.get("ramp") or {}
        out["sales_path"] = {
            "level": sp.get("level"),
            "level_name": sp.get("level_name"),
            "green_weeks": sp.get("green_weeks"),
            "form": sp.get("form"),
            "ramp_status": ramp.get("status"),
            "pre30_avg_weekly_earnings": ramp.get("pre30_avg_earnings"),
            "post30_avg_weekly_earnings": ramp.get("post30_avg_earnings"),
        }
    return out


async def build_team(user_ids: list[str], team_name: str, iso_from: str, iso_to: str) -> dict:
    names = await _names_for(user_ids)
    team_field = await field_summary(user_ids, iso_from, iso_to)
    members = []
    for uid in user_ids:
        members.append({
            "name": names.get(uid, "Unknown"),
            "user_id": uid,
            "field": await field_summary([uid], iso_from, iso_to),
            "bells": await bells_summary(uid, iso_from, iso_to),
        })
    # Members with any activity first, by field sales.
    members.sort(key=lambda m: m["field"]["totals"].get("sales", 0), reverse=True)
    return {
        "scope": "team",
        "name": team_name,
        "member_count": len(user_ids),
        "range": {"from": iso_from, "to": iso_to},
        "team_field": team_field,
        "members": members,
    }


# ── AI narrative ────────────────────────────────────────────────────────────
_SYSTEM = (
    "You are a sharp, supportive performance coach for self-employed Brand "
    "Ambassadors (BAs) who fundraise door to door. You write concise, specific "
    "performance reviews from the NUMBERS PROVIDED ONLY — never invent figures. "
    "The funnel, by its Field IQ names, is: doors knocked → spoken (spoken_to) → "
    "presented (pitches_commenced) → closed (pitches_closed) → sign-ups (sales). "
    "'LOA' = law of averages (how many of each step per sign-up). "
    "Bells = the sign-up sheet (days worked, sign-ups/week, piece average = sign-ups "
    "per day worked). "
    "Call out the single weakest funnel step and attendance vs output. "
    "Give 2-3 concrete coaching actions. Output PLAIN TEXT (no markdown symbols): use "
    "SHORT CAPS headers and '- ' bullets. Keep it tight and human. "
    + BRITISH_ENGLISH + " " + SELF_EMPLOYED_TERMS
)


async def ai_narrative(structured: dict) -> str:
    from core.llm_keys import anthropic_api_key
    api_key = anthropic_api_key()
    if not api_key:
        return ""
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
    except Exception as e:
        logger.warning("report AI unavailable: %s", e)
        return ""
    import json
    scope = structured.get("scope")
    who = structured.get("name")
    prompt = (
        f"Write a {scope} performance report for {who} covering "
        f"{structured['range']['from']} to {structured['range']['to']}.\n\n"
        f"Here is the data (JSON):\n{json.dumps(structured, default=str)}\n\n"
        "Structure: a 1-line headline, then sections FIELD, ATTENDANCE (Bells), "
        "and COACHING ACTIONS. "
        + ("For a team, give a short team read then a one-line call-out per member." if scope == "team" else "")
    )
    try:
        chat = LlmChat(api_key=api_key, session_id=f"report-{structured.get('user_id') or who}",
                       system_message=_SYSTEM).with_model("anthropic")
        return await chat.send_message(UserMessage(text=prompt)) or ""
    except Exception as e:
        logger.error("report AI call failed: %s", e)
        return ""
