"""Bells — the weekly sign-ups board: per-person, per-week entry with
auto-calculated sign-up fees, totals and averages. Office-scoped.

The day fields keep the original data model's names, re-meant for Vertex:
`under30` = £12 Standard sign-ups, `over30` = £15+ (Target £15 / Premium £20)
sign-ups. `memberships` is not used by Vertex — it stays on stored rows but is
never shown, totalled into sign-ups or paid.

Data model (bells_entries collection):
    {
        id: uuid,
        office_id: str,
        user_id: str (ObjectId as str) | None (if rep has no app account),
        user_name: str,               # denormalized name (editable)
        stage: int (1-5),             # 1 New Hire, 2 Trainee, 3 Leader, 4 TL, 5 AO
        break_even: number | None,    # BE — weekly break-even target sales
        weekly_goal: number | None,   # WG — weekly goal
        last_week_total: number | None,  # LW — historical carryover (optional; auto-filled from previous week on fetch)
        week_ending: str,             # Sunday date YYYY-MM-DD
        days: [                       # 7 entries Mon..Sun (0..6)
            {
                over30: number | None,       # £15+ sign-ups
                under30: number | None,      # £12 sign-ups
                memberships: number | None,  # legacy, unused
                status: "normal" | "nc" | "rt" | "off",  # nc=not counted, rt=returned, off=didn't work
            }
        ],
        created_by_id: str,
        created_at: iso,
        updated_at: iso,
    }
"""
import uuid
import logging
import secrets
from datetime import datetime, timezone, date, timedelta
from typing import Optional, List
from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from fastapi import APIRouter, HTTPException, Request

from auth import get_current_user, require_super_admin, get_subtree_ids
from database import db
from core.office_helpers import get_office_filter, resolve_office_id
from core.goal_audit import record_goal_change
from core.achievements import award_sales_milestones, reconcile_sales_and_team_badges
from core.app_time import APP_TZ
from core.rate_limit import Limiter, client_ip
from core.week_bands import GREEN_WEEK_SALES
from core.vertex_pay import mc_fees, normalize_fees, sign_up_fees

logger = logging.getLogger(__name__)
router = APIRouter()


async def _leader_can_touch_bell(user: dict, entry: dict) -> bool:
    if user.get("role") != "leader" or user.get("is_super_admin"):
        return True
    entry_user_id = str(entry.get("user_id") or "")
    if not entry_user_id:
        return False
    allowed = set(await get_subtree_ids(user["id"]))
    allowed.add(str(user["id"]))
    return entry_user_id in allowed


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _empty_day() -> dict:
    # Default status = "off" (user later flips to "in" automatically when any number is entered)
    return {"over30": None, "under30": None, "memberships": None, "status": "off"}


def _is_in_day(d: dict) -> bool:
    """A day counts as 'in' (working) for piece-average and scoring purposes ONLY when
    status is explicitly 'in'. RT, NC, Off (and legacy 'normal') are excluded."""
    return (d or {}).get("status") == "in"


def _normalize_days(raw) -> list:
    """Coerce a week of 7 days into a clean uniform shape. Always returns exactly 7.

    Runtime rules (kept minimal so explicit user toggles are always respected):
    - Unknown / missing / legacy 'normal' statuses collapse to 'off'.
    - 'off' with any typed numeric value > 0 is auto-promoted to 'in'
      (so typing a number without first tapping the chip still counts).
    - 'in' / 'off' / 'rt' / 'nc' are all preserved exactly as the user set them,
      even when no numbers have been typed yet (valid state: a rep who was in
      but scored 0 that day).

    NOTE: The one-time backfill script at /app/backend/scripts/migrate_bells_statuses.py
    handles legacy rows where status='in' was migrated from the old 'normal' value
    without the rep ever typing anything — it rewrites those to 'off'. That logic
    MUST NOT live here; applying it at runtime would wipe out any fresh 'in' toggle
    the user makes before they type a number.
    """
    if not isinstance(raw, list):
        raw = []
    out = []
    for i in range(7):
        d = raw[i] if i < len(raw) and isinstance(raw[i], dict) else {}
        over30 = _num_or_none(d.get("over30"))
        under30 = _num_or_none(d.get("under30"))
        memberships = _num_or_none(d.get("memberships"))
        raw_status = d.get("status")
        # Legacy 'normal' and any unknown/missing status default to 'off'.
        # 'ab' = Absent (scheduled but didn't show) — treated like off for
        # scoring purposes but distinct in the UI.
        if raw_status not in ("in", "nc", "rt", "off", "ab", "pc"):
            raw_status = "off"
        # Auto-promote: typing any number > 0 flips 'off' -> 'in'.
        # AB is left as-is — admin must explicitly toggle to In if data is added.
        if raw_status == "off" and ((over30 or 0) > 0 or (under30 or 0) > 0 or (memberships or 0) > 0):
            raw_status = "in"
        out.append({
            "over30": over30,
            "under30": under30,
            "memberships": memberships,
            "status": raw_status,
        })
    return out


def _num_or_none(v):
    if v is None or v == "":
        return None
    try:
        # keep ints as ints
        f = float(v)
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        return None


def _is_valid_sunday(s: str) -> bool:
    try:
        d = datetime.strptime(s, "%Y-%m-%d").date()
        return d.weekday() == 6  # Sunday == 6
    except Exception:
        return False


def _coerce_to_sunday(s: str) -> Optional[str]:
    """If `s` is a valid YYYY-MM-DD but not a Sunday, snap BACKWARD to the most
    recent Sunday. This handles the common timezone quirk where a client in a
    timezone behind UTC sends e.g. Monday's UTC date when the user's local time
    was still Sunday evening. Returns None only if the input isn't a valid date."""
    try:
        d = datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None
    # Python's weekday(): Monday=0..Sunday=6
    # Offset to roll BACK to previous Sunday (or 0 if already Sunday)
    back_offset = (d.weekday() + 1) % 7
    return (d - timedelta(days=back_offset)).isoformat()


def _prev_sunday_iso(week_ending: str) -> Optional[str]:
    try:
        d = datetime.strptime(week_ending, "%Y-%m-%d").date()
        return (d - timedelta(days=7)).isoformat()
    except Exception:
        return None


# The current bells week's Sunday is at most 6 days ahead of a UK Monday, so
# anything more than 7 days out is a typo or a bad client clock — two such
# rows escaped into prod with far-future week_endings before this clamp.
MAX_FUTURE_WEEK_DAYS = 7


def _validate_week_ending_write(raw: str) -> str:
    """Normalize + clamp a caller-supplied week_ending on a WRITE path.

    Snaps to a Sunday via _coerce_to_sunday (backward — same rule as the read
    paths, so a client whose UTC date has rolled to Monday while it's still
    Sunday evening in UK time lands in the right week) and rejects any week_ending
    more than MAX_FUTURE_WEEK_DAYS days ahead of today in UK time (APP_TZ) with a 400."""
    coerced = _coerce_to_sunday((raw or "").strip())
    if not coerced:
        raise HTTPException(status_code=400, detail="week_ending must be a valid YYYY-MM-DD date")
    today_uk = datetime.now(APP_TZ).date()
    week_date = datetime.strptime(coerced, "%Y-%m-%d").date()
    if (week_date - today_uk).days > MAX_FUTURE_WEEK_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"week_ending {coerced} is more than {MAX_FUTURE_WEEK_DAYS} days in the future",
        )
    return coerced


def _safe_num(v, default=0):
    try:
        return float(v) if v is not None else default
    except Exception:
        return default


def _stage_label(value) -> Optional[str]:
    """OwnerIQ's "stage_3_plus" as it reads on the sheet: "3+"."""
    text = str(value or "").strip().lower()
    digits = "".join(ch for ch in text if ch.isdigit())
    if not digits:
        return None
    return f"{int(digits)}+" if text.endswith("plus") else str(int(digits))


def compute_totals(entry: dict, fees: Optional[dict]) -> dict:
    """Derive all calculated fields from an entry + the office's fee schedule.

    `earnings` is the BA's estimated sign-up fees for the week (Vertex pay,
    core/vertex_pay.sign_up_fees): £12 sign-ups × fee_standard + £15+
    sign-ups × fee_target. It is before the 3rd direct-debit bonus and any
    leadership deduction — Bells records neither; the Pay tab adds them.
    `fees` may be None or an old-shape document: the defaults fill the gaps.
    """
    days = entry.get("days") or []
    o30 = sum(_safe_num(d.get("over30")) for d in days)
    u30 = sum(_safe_num(d.get("under30")) for d in days)
    mem = sum(_safe_num(d.get("memberships")) for d in days)
    sales = o30 + u30

    # Per-day totals (over30 + under30). Only "in" days contribute to the daily total strip
    # (rt / nc / off days show as 0 so piece_avg + scoring aren't polluted by retrain days).
    daily_totals = []
    for d in days:
        if _is_in_day(d):
            daily_totals.append(int(_safe_num(d.get("over30")) + _safe_num(d.get("under30"))))
        else:
            daily_totals.append(0)

    # days_worked = ALL "in" days, even if 0 sales were entered. The act of
    # marking yourself 'in' is itself a "day worked"; if you turned up but
    # didn't ring a bell, that day still counts toward your piece average
    # denominator (matching how the printed bells sheet treats them).
    # RT / NC / Off are excluded from days_worked.
    days_worked = sum(1 for d in days if _is_in_day(d))
    # Piece avg denominator = in-days; numerator = sales on in-days
    in_day_sales = sum(
        int(_safe_num(d.get("over30")) + _safe_num(d.get("under30")))
        for d in days if _is_in_day(d)
    )
    piece_avg = round(in_day_sales / days_worked, 2) if days_worked > 0 else 0.0

    # Scoring % = in-days with ≥1 sale divided by total in-days
    in_days_total = sum(1 for d in days if _is_in_day(d))
    in_days_with_sale = sum(
        1 for d in days if _is_in_day(d)
        and (int(_safe_num(d.get("over30")) + _safe_num(d.get("under30"))) > 0)
    )
    scoring_pct = round((in_days_with_sale / in_days_total) * 100) if in_days_total > 0 else 0

    # Vertex sign-up fees: £12 sign-ups (under30) at fee_standard, £15+
    # sign-ups (over30) at fee_target — the office's knobs, or the defaults
    # when nothing is stored (core/vertex_pay.py). `memberships` is a legacy
    # field Vertex doesn't use: it is kept on the row but never paid.
    earnings_breakdown = sign_up_fees(u30, o30, fees)
    earnings = earnings_breakdown["sign_up_fees"]

    aepd = round(earnings / days_worked, 2) if days_worked > 0 else 0.0

    # Reliability: Mon–Sat days "in" / Mon–Sat days not pre-authorised off.
    # AB / RT / PC = valid pre-determined day off — excluded from denominator.
    # "off" / "nc" on a non-Sunday = unauthorised absence (counts against).
    # Sunday (index 6) is always excluded.
    _auth_off = {"ab", "rt", "pc"}
    mon_sat = days[:6]
    expected_days = sum(1 for d in mon_sat if (d.get("status") or "off") not in _auth_off)
    rel_worked = sum(1 for d in mon_sat if d.get("status") == "in")
    reliability_pct = round(rel_worked / expected_days * 100) if expected_days > 0 else None

    return {
        "total_over30": int(o30),
        "total_under30": int(u30),
        "total_memberships": int(mem),
        "total_sales": int(sales),
        "days_worked": days_worked,
        "piece_average": piece_avg,
        "scoring_pct": scoring_pct,
        "reliability_pct": reliability_pct,
        "earnings": round(earnings, 2),
        "average_earnings_per_day": aepd,
        "daily_totals": daily_totals,
        "earnings_breakdown": earnings_breakdown,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────


async def _enrich_entries_with_teams(entries: list) -> None:
    """Mutates the given entries list in place, adding `teams` (list) and
    `primary_team` (object | None) to each.

    Section-leader rule (Apr 2026 — match the office's printed weekly
    bells sheet):  a user qualifies as a "section leader" (i.e. gets their
    own colored team section in the UI) **only if** they:
      1. are a leader/admin
      2. have a non-empty `team_name`
      3. have at least one direct report whose role == 'leader' (a sub-leader)

    Otherwise the user folds into the nearest ancestor's section (or has
    `primary_team = None` when no ancestor qualifies — those rows render
    in the "Unassigned" group).
    """
    uids_for_teams = [e["user_id"] for e in entries if e.get("user_id")]
    if not uids_for_teams:
        for e in entries:
            e["teams"] = []
            e["primary_team"] = None
        return

    # Pull all users for the relevant office(s) so we can compute
    # is_section_leader without re-walking children per row.
    office_ids = {e.get("office_id") for e in entries if e.get("office_id")}
    user_filter: dict = {"_id": {"$in": [ObjectId(x) for x in uids_for_teams]}}
    if office_ids:
        # Pull every user in those offices so we can check direct reports
        user_filter = {"office_id": {"$in": list(office_ids)}, "is_active": {"$ne": False}, "deleted": {"$ne": True}}

    cache: dict = {}
    children_of: dict = {}
    async for u in db.users.find(
        user_filter,
        {"_id": 1, "team_name": 1, "reports_to": 1, "role": 1, "name": 1},
    ):
        uid = str(u["_id"])
        cache[uid] = u
        parent = u.get("reports_to")
        if parent:
            children_of.setdefault(str(parent), []).append(uid)

    async def _load(uid: str):
        if uid in cache:
            return cache[uid]
        try:
            u = await db.users.find_one(
                {"_id": ObjectId(uid)},
                {"_id": 1, "team_name": 1, "reports_to": 1, "role": 1, "name": 1},
            )
        except Exception:
            u = None
        cache[uid] = u or {}
        return cache[uid]

    def _is_section_leader(uid: str) -> bool:
        u = cache.get(uid) or {}
        if not u:
            return False
        if u.get("role") not in ("leader", "admin"):
            return False
        if not (u.get("team_name") or "").strip():
            return False
        # Has at least one direct report whose role == 'leader'?
        for cid in children_of.get(uid, []):
            cu = cache.get(cid) or {}
            if cu.get("role") == "leader":
                return True
        return False

    team_by_uid: dict = {}
    for uid in uids_for_teams:
        teams: list = []
        primary: Optional[dict] = None
        # Self check first — only if user qualifies as a section leader
        if _is_section_leader(uid):
            current = cache.get(uid) or {}
            t_self = {
                "leader_id": uid,
                "leader_name": current.get("name"),
                "team_name": (current.get("team_name") or "").strip(),
            }
            teams.append(t_self)
            primary = t_self
        # Walk up the reports_to chain looking for the nearest section leader
        visited_chain = {uid}
        parent_id = (cache.get(uid) or {}).get("reports_to")
        for _ in range(8):
            if not parent_id or parent_id in visited_chain:
                break
            visited_chain.add(parent_id)
            parent = await _load(parent_id)
            if not parent:
                break
            if _is_section_leader(parent_id):
                t = {
                    "leader_id": parent_id,
                    "leader_name": parent.get("name"),
                    "team_name": (parent.get("team_name") or "").strip(),
                }
                teams.append(t)
                if not primary:
                    primary = t
            parent_id = parent.get("reports_to")
        team_by_uid[uid] = {"teams": teams, "primary_team": primary}

    for e in entries:
        uid = e.get("user_id")
        info = team_by_uid.get(uid) if uid else None
        if info:
            e["teams"] = info["teams"]
            e["primary_team"] = info["primary_team"]
        else:
            e["teams"] = []
            e["primary_team"] = None


def _attach_team_subtree_sales(entries: list, reports_to_map: dict) -> None:
    """Adds `team_subtree_sales` — this person's sales plus their whole
    downline's, for the week already computed onto the entries.

    The sheet is grouped into SECTIONS, and a member only lands in the nearest
    section-leader ancestor's section. So a leader whose reports are themselves
    section leaders ends up alone in their own section, and summing that
    section reports just their personal sales. Their crew GOAL, though, covers
    everyone under them — that's how the Weekly Planner counts a team total
    (get_subtree_ids). This gives the goal a like-for-like number to sit next
    to. Call AFTER compute_totals has populated total_sales.
    """
    sales = {e["user_id"]: int(e.get("total_sales") or 0) for e in entries if e.get("user_id")}
    children: dict = {}
    for uid, parent in reports_to_map.items():
        if parent and str(parent) != uid:
            children.setdefault(str(parent), []).append(uid)

    memo: dict = {}

    def subtotal(uid: str, path: frozenset) -> int:
        if uid in memo:
            return memo[uid]
        if uid in path:  # defensive: a reports_to cycle must not recurse forever
            return 0
        branch = path | {uid}
        total = sales.get(uid, 0) + sum(subtotal(c, branch) for c in children.get(uid, []))
        memo[uid] = total
        return total

    for e in entries:
        uid = e.get("user_id")
        if uid:
            e["team_subtree_sales"] = subtotal(uid, frozenset())


async def _attach_absence_details(entries: list, office_id: str, week_ending: str) -> None:
    """Mutates entries in place, adding `absence_details` — a map of
    day-index → {reason, decided_at, decided_by_name, requested_by, status}
    for every APPROVED absence in this office/week.

    An `ab` on a bells row records only *that* someone was absent; the why and
    the who-approved-it live on the absence_request. The Bells table and the
    public sheet surface that on tap/hover, so the sheet explains itself
    without anyone digging through the approvals inbox.
    """
    for e in entries:
        e["absence_details"] = {}
    by_uid: dict = {}
    for e in entries:
        if e.get("user_id"):
            by_uid.setdefault(e["user_id"], []).append(e)
    if not by_uid:
        return
    try:
        async for r in db.absence_requests.find(
            {
                "office_id": office_id,
                "week_ending": week_ending,
                "status": "approved",
                "target_user_id": {"$in": list(by_uid.keys())},
            },
            {"_id": 0},
        ):
            rows = by_uid.get(r.get("target_user_id")) or []
            if not rows:
                continue
            detail = {
                "reason": r.get("reason") or "",
                "decided_at": r.get("decided_at"),
                "decided_by_name": r.get("decided_by_name") or "",
                "requested_by": r.get("requester_name") or "",
                "decision_note": r.get("decision_note") or "",
            }
            for i in (r.get("day_indices") or []):
                if isinstance(i, (int, float)) and 0 <= int(i) <= 6:
                    for e in rows:
                        # Later approvals win for the same day (a re-request
                        # after a withdrawal).
                        e["absence_details"][str(int(i))] = detail
    except Exception as _e:
        logger.warning(f"_attach_absence_details failed for {office_id}/{week_ending}: {_e}")


def _section_aware_sort(entries: list, reports_to_map: dict, join_key=None, role_map: dict | None = None) -> list:
    """Sort already-enriched bells entries (each entry has `primary_team`) so
    that the office's printed bells sheet ordering is reproduced:

      • Entries are bucketed by their `primary_team.leader_id` (or the
        synthetic '__no_team__' bucket for entries without a primary team).
      • Sections led by an ADMIN are pinned first (the office owner and
        their team always sit at the top of the sheet), then sections in
        order of total_sales DESC; '__no_team__' is last.
      • Within a section the section-leader is **pinned at the top**, then
        their direct reports are emitted leaves-first (newest joined first)
        followed by branches, each branch immediately followed by its own
        sub-tree (recursively).

    Parameters:
      entries: list of enriched bells rows (must already have primary_team
               annotated by `_enrich_entries_with_teams`).
      reports_to_map: uid -> parent_uid lookup (parent uid as string or None).
      join_key: optional callable(uid)->key that determines sibling order.
                Newer joiners should sort earlier (the helper sorts DESC).
                Defaults to alphabetic on user_name DESC.

    Returns: a new list of entries in the desired order.
    """
    if not entries:
        return entries

    if join_key is None:
        # Stable fallback: alphabetic by name, but the global default is to
        # sort with reverse=True so we negate by inverting the case-fold so
        # newest names (whatever that means without a date) end up at the
        # top. In practice callers should pass a real join_key.
        def join_key(_uid: str) -> str:
            return ""

    by_uid = {e.get("user_id"): e for e in entries if e.get("user_id")}

    # Bucket by section
    sections: dict = {}
    section_sales: dict = {}
    for e in entries:
        pt = e.get("primary_team") or None
        key = pt.get("leader_id") if pt else "__no_team__"
        sections.setdefault(key, []).append(e)
        section_sales[key] = section_sales.get(key, 0) + int(e.get("total_sales") or 0)

    def _admin_led(k) -> bool:
        if not k or k == "__no_team__":
            return False
        if role_map and role_map.get(k) == "admin":
            return True
        e = by_uid.get(k)
        return bool(e and e.get("role") == "admin")

    section_order = sorted(
        sections.keys(),
        key=lambda k: (
            2 if k == "__no_team__" else (0 if _admin_led(k) else 1),
            -section_sales.get(k, 0),
            k or "",
        ),
    )

    def _sort_section(section_leader_id, members):
        if not members:
            return []
        member_ids = {m.get("user_id") for m in members if m.get("user_id")}

        # Build a children map *scoped to this section only* (so a sub-tree
        # rooted in another section never bleeds across).
        children_of: dict = {}
        for m in members:
            uid = m.get("user_id")
            if not uid:
                continue
            parent = reports_to_map.get(uid)
            if (
                parent
                and parent in member_ids
                and parent != section_leader_id
                and parent != uid
            ):
                children_of.setdefault(parent, []).append(uid)

        def _has_children(uid: str) -> bool:
            return bool(children_of.get(uid))

        out: list = []
        visited: set = set()

        def _emit(uid_list: list):
            leaves = [u for u in uid_list if not _has_children(u)]
            branches = [u for u in uid_list if _has_children(u)]
            leaves.sort(key=join_key, reverse=True)
            branches.sort(key=join_key, reverse=True)
            for u in leaves:
                if u in visited:
                    continue
                visited.add(u)
                if u in by_uid:
                    out.append(by_uid[u])
            for u in branches:
                if u in visited:
                    continue
                visited.add(u)
                if u in by_uid:
                    out.append(by_uid[u])
                _emit(children_of.get(u, []))

        # 1) Pin section leader at top
        if section_leader_id and section_leader_id in member_ids:
            out.append(by_uid[section_leader_id])
            visited.add(section_leader_id)
            direct = [
                m["user_id"] for m in members
                if m.get("user_id")
                and m["user_id"] != section_leader_id
                and reports_to_map.get(m["user_id"]) == section_leader_id
            ]
            _emit(direct)

        # 2) Everything the leader-pin didn't reach. This covers two cases:
        #    - orphans whose parent fell into a different section, and
        #    - the whole section when its leader has no bells row (e.g. the
        #      public sheet, where an admin section-leader may not appear).
        #    Only seed _emit with section *roots* — members whose parent is
        #    another member — are reached by recursion, so a trainee always
        #    nests under their leader instead of floating up as a top-level
        #    leaf.
        child_uids = {c for kids in children_of.values() for c in kids}
        leftover = [
            m["user_id"] for m in members
            if m.get("user_id")
            and m["user_id"] not in visited
            and m["user_id"] not in child_uids
        ]
        leftover.sort(key=join_key, reverse=True)
        _emit(leftover)

        # Safety net: emit anything still unreached (e.g. a reports_to cycle
        # where no node qualified as a root) so no row is silently dropped.
        stragglers = [
            m["user_id"] for m in members
            if m.get("user_id") and m["user_id"] not in visited
        ]
        stragglers.sort(key=join_key, reverse=True)
        _emit(stragglers)

        # 3) Entries without user_id (legacy rows) — alphabetical
        no_id = [m for m in members if not m.get("user_id")]
        no_id.sort(key=lambda e: (e.get("user_name") or "").lower())
        return out + no_id

    ordered: list = []
    for key in section_order:
        leader_id = None if key == "__no_team__" else key
        ordered.extend(_sort_section(leader_id, sections[key]))
    return ordered


def _aggregate_teams_from_enriched(enriched: list, prev_rows_by_key: dict, today_dow: int) -> list:
    """Group already-enriched entries by primary_team.leader_id and compute
    per-team stats (member_count, sales, days, P/A, scoring%, vs-last-week).

    Returns a list sorted by total_sales DESC then team_name ASC. Members with
    no primary_team are omitted.
    """
    groups: dict = {}
    for e in enriched:
        pt = e.get("primary_team")
        if not pt:
            continue
        lid = pt.get("leader_id")
        if not lid:
            continue
        g = groups.setdefault(lid, {
            "leader_id": lid,
            "leader_name": pt.get("leader_name"),
            "team_name": pt.get("team_name"),
            "member_ids": [],
            "member_count": 0,
            "total_sales": 0,
            "total_memberships": 0,
            "total_over30": 0,
            "total_under30": 0,
            "days_worked": 0,
            "earnings": 0.0,
            "in_days": 0,
            "in_days_with_sale": 0,
            "working_today": 0,
            "members_with_entries": 0,
            "last_week_total_sales": 0,
            "reps_active": 0,
            "reps_green": 0,
        })
        g["member_ids"].append(e.get("user_id"))
        g["member_count"] += 1
        g["total_sales"] += int(e.get("total_sales") or 0)
        g["total_memberships"] += int(e.get("total_memberships") or 0)
        g["total_over30"] += int(e.get("total_over30") or 0)
        g["total_under30"] += int(e.get("total_under30") or 0)
        g["days_worked"] += int(e.get("days_worked") or 0)
        g["earnings"] += float(e.get("earnings") or 0)
        # Per-day stats for P/A + scoring %
        has_data = False
        for d in (e.get("days") or []):
            if d and d.get("status") == "in":
                g["in_days"] += 1
                s = int((d.get("over30") or 0) + (d.get("under30") or 0))
                if s > 0:
                    g["in_days_with_sale"] += 1
            if (d or {}).get("status") == "in" or (d or {}).get("over30") or (d or {}).get("under30") or (d or {}).get("memberships"):
                has_data = True
        if has_data:
            g["members_with_entries"] += 1
        # Green tracking — active rep = had at least 1 in-day this week
        e_in_days = sum(1 for d in (e.get("days") or []) if d and d.get("status") == "in")
        if e_in_days > 0:
            g["reps_active"] += 1
            if int(e.get("total_sales") or 0) >= GREEN_WEEK_SALES:
                g["reps_green"] += 1
        days = e.get("days") or []
        if 0 <= today_dow < len(days):
            td = days[today_dow] or {}
            if td.get("status") == "in":
                g["working_today"] += 1
        # Prior-week sum for vs-LW delta
        key = e.get("user_id") or (e.get("user_name") or "").strip().lower()
        g["last_week_total_sales"] += int(prev_rows_by_key.get(key) or 0)

    out = []
    for g in groups.values():
        piece_avg = round(g["total_sales"] / g["in_days"], 2) if g["in_days"] > 0 else 0.0
        scoring = round((g["in_days_with_sale"] / g["in_days"]) * 100) if g["in_days"] > 0 else 0
        weekly_avg = round(g["total_sales"] / g["member_count"], 2) if g["member_count"] > 0 else 0.0
        delta = g["total_sales"] - g["last_week_total_sales"]
        delta_pct = None
        if g["last_week_total_sales"] > 0:
            delta_pct = round((delta / g["last_week_total_sales"]) * 100, 1)
        pct_over30 = round((g["total_over30"] / g["total_sales"]) * 100) if g["total_sales"] > 0 else 0
        pct_under30 = round((g["total_under30"] / g["total_sales"]) * 100) if g["total_sales"] > 0 else 0
        pct_mem = round((g["total_memberships"] / g["total_sales"]) * 100) if g["total_sales"] > 0 else 0
        green_pct = round((g["reps_green"] / g["reps_active"]) * 100) if g["reps_active"] > 0 else 0
        out.append({
            "leader_id": g["leader_id"],
            "leader_name": g["leader_name"],
            "team_name": g["team_name"],
            "member_ids": g["member_ids"],
            "member_count": g["member_count"],
            "total_sales": g["total_sales"],
            "total_memberships": g["total_memberships"],
            "total_over30": g["total_over30"],
            "total_under30": g["total_under30"],
            "pct_over30": pct_over30,
            "pct_under30": pct_under30,
            "pct_memberships": pct_mem,
            "scoring_pct": scoring,
            "green_pct": green_pct,
            "reps_active": g["reps_active"],
            "reps_green": g["reps_green"],
            "days_worked": g["days_worked"],
            "earnings": round(g["earnings"], 2),
            "piece_average": piece_avg,
            "scoring_pct": scoring,
            "weekly_average": weekly_avg,
            "working_today": g["working_today"],
            "members_with_entries": g["members_with_entries"],
            "last_week_total_sales": g["last_week_total_sales"] if g["last_week_total_sales"] > 0 else None,
            "sales_delta": delta,
            "sales_delta_pct": delta_pct,
        })
    out.sort(key=lambda x: (-x["total_sales"], (x["team_name"] or "").lower()))
    return out


@router.get("/bells")
async def list_bells(
    request: Request,
    week: Optional[str] = None,
    office: Optional[str] = None,
):
    """List entries for a given week (defaults to most recent). Office-scoped."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")

    # Determine week_ending — be lenient: if caller sends a non-Sunday date
    # (timezone quirk on the client), roll forward to the next Sunday.
    if week:
        coerced = _coerce_to_sunday(week)
        if not coerced:
            raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
        week_ending = coerced
    else:
        today = datetime.now(APP_TZ).date()
        offset = (today.weekday() - 6) % 7  # days since Sunday
        week_ending = (today - timedelta(days=offset)).isoformat()

    # Office scoping
    if user.get("is_super_admin") and office:
        office_id = office
    else:
        office_id = user.get("office_id")
        if not office_id:
            first = await db.offices.find_one({}, sort=[("created_at", 1)])
            office_id = first["id"] if first else ""

    # Current week entries — scoped by role:
    # - Leaders: only see entries belonging to users in their subtree (self + descendants)
    # - Admins / Super admins: see every entry in the office
    entries_filter: dict = {"office_id": office_id, "week_ending": week_ending}
    leader_subtree_ids: Optional[set] = None
    if user.get("role") == "leader" and not user.get("is_super_admin"):
        try:
            sub = await get_subtree_ids(user["id"])  # includes self
            leader_subtree_ids = {str(x) for x in sub}
            leader_subtree_ids.add(str(user["id"]))  # belt + suspenders
        except Exception:
            leader_subtree_ids = {str(user["id"])}
        # MongoDB-side filter: only match entries whose user_id is in the subtree
        entries_filter["user_id"] = {"$in": list(leader_subtree_ids)}
    cur = db.bells_entries.find(entries_filter, {"_id": 0}).sort("user_name", 1)
    entries = await cur.to_list(500)

    # ── AUTO-POPULATE: include every team member (even without entries this week) ─
    # Leader: see their own subtree (descendants + self).
    # Admin: see every trainee + leader in the office.
    # Super admin: same as admin on whatever office is selected.
    # Admins are hidden from the list (they don't carry sales typically).
    existing_uids = {e.get("user_id") for e in entries if e.get("user_id")}
    existing_names = {(e.get("user_name") or "").strip().lower() for e in entries if not e.get("user_id")}

    roster_filter: dict = {"office_id": office_id}
    if user.get("role") == "leader" and not user.get("is_super_admin"):
        subtree_ids = await get_subtree_ids(user["id"])  # includes self
        try:
            roster_filter["_id"] = {"$in": [ObjectId(uid) for uid in subtree_ids]}
        except Exception:
            roster_filter["_id"] = {"$in": []}
    # Admins (non-super) — only their office; super admins may pass office param
    # (handled above via office_id). Include admins in the roster too — many
    # super-admins (e.g. office owner) record their own sales alongside the
    # team. They appear like any other leader in Bells / Cards / Table views.
    roster_filter["role"] = {"$in": ["trainee", "leader", "admin"]}
    roster_filter["is_active"] = {"$ne": False}
    roster_filter["deleted"] = {"$ne": True}
    # Walk-around demo accounts (is_demo) are spectators — never on the sheet.
    roster_filter["is_demo"] = {"$ne": True}

    # Pull start_date from new_hires per user (trainees only). Cache:
    hire_start: dict = {}
    async for h in db.new_hires.find({"office_id": office_id}, {"trainee_user_id": 1, "start_date": 1, "outcome": 1}):
        if h.get("trainee_user_id"):
            hire_start[str(h["trainee_user_id"])] = {
                "start_date": h.get("start_date"),
                "outcome": h.get("outcome"),
            }

    roster_users = db.users.find(roster_filter, {"_id": 1, "name": 1, "email": 1, "role": 1})
    week_end_date = datetime.strptime(week_ending, "%Y-%m-%d").date()

    async for u in roster_users:
        uid = str(u["_id"])
        if uid in existing_uids:
            continue
        # Skip trainees whose start_date is after this week
        hs = hire_start.get(uid) or {}
        sd_raw = hs.get("start_date")
        if sd_raw:
            try:
                sd = datetime.strptime(str(sd_raw)[:10], "%Y-%m-%d").date()
                if sd > week_end_date:
                    continue
            except Exception:
                pass
        # Skip trainees flagged as not-in-progress (passed ok, only hide 'failed')
        if hs.get("outcome") == "failed":
            continue
        name = u.get("name") or u.get("email") or "Unknown"
        if name.strip().lower() in existing_names:
            continue
        entries.append({
            "id": None,  # stub — will be created on first save
            "office_id": office_id,
            "user_id": uid,
            "user_name": name,
            "role": u.get("role"),
            "stage": None,
            "break_even": None,
            "weekly_goal": None,
            "team_weekly_goal": None,
            "last_week_total": None,
            "week_ending": week_ending,
            "days": _normalize_days([]),
        })

    # ── Bells mirrors the plan: adopt a planned Sales Goal ────────────────
    # A goal typed into a FUTURE week's Weekly Plan can't be mirrored onto
    # bells rows at write time (bells' own +7d future clamp), so when the
    # sheet for that week is finally viewed, any admin crew-goal cell still
    # empty adopts the plan's number. An explicit clear on Bells also clears
    # the plan (goal_sync), so this never resurrects a cleared goal.
    try:
        admin_rows_missing_goal = [e for e in entries if e.get("team_weekly_goal") is None]
        if admin_rows_missing_goal:
            from core.goal_sync import _as_int as _goal_as_int
            _ag = await db.weekly_agendas.find_one(
                {"office_id": office_id, "week_ending": week_ending},
                {"_id": 0, "stats.weekly_goal": 1},
            )
            _plan_goal = _goal_as_int(((_ag or {}).get("stats") or {}).get("weekly_goal"))
            if _plan_goal is not None:
                # Office-level admins only — a crew-leading admin's empty goal
                # cell means that team hasn't set a target, not that it should
                # inherit the office's.
                from core.admin_scope import office_level_admin_ids
                _admin_ids = {
                    str(a["_id"]) for a in await office_level_admin_ids(office_id)
                }
                for e in entries:
                    if e.get("user_id") in _admin_ids and e.get("team_weekly_goal") is None:
                        e["team_weekly_goal"] = float(_plan_goal)
                        if e.get("id"):
                            await db.bells_entries.update_one(
                                {"id": e["id"]}, {"$set": {"team_weekly_goal": float(_plan_goal)}}
                            )
    except Exception as _e:
        logger.warning(f"bells: plan-goal adopt failed for {office_id}/{week_ending}: {_e}")

    # Backfill role for existing entries (if missing) so earnings compute stays current,
    # and fetch `reports_to` so we can sort entries in hierarchy order (each leader followed
    # by their direct reports, recursively down the tree).
    #
    # IMPORTANT: We must populate reports_to_map from the FULL `entries` set
    # (including stitched-in roster users that have no saved bells_entries
    # document yet), otherwise `_section_aware_sort` cannot link a stitched-in
    # trainee to their parent and they get dumped into the leftover bucket
    # — causing them to appear out-of-order interleaved with leaves of the
    # section leader instead of correctly nested under their direct leader.
    reports_to_map: dict = {}
    role_map: dict = {}
    active_map: dict = {}
    all_uids = [e["user_id"] for e in entries if e.get("user_id")]
    if all_uids:
        try:
            async for u in db.users.find(
                {"_id": {"$in": [ObjectId(x) for x in all_uids]}},
                {"_id": 1, "role": 1, "reports_to": 1, "deleted": 1, "is_active": 1},
            ):
                uid = str(u["_id"])
                role_map[uid] = u.get("role")
                reports_to_map[uid] = u.get("reports_to")
                active_map[uid] = not u.get("deleted") and u.get("is_active") is not False
            for e in entries:
                if e.get("user_id") and not e.get("role"):
                    e["role"] = role_map.get(e["user_id"])
            # Flag entries whose account is gone (soft-deleted, deactivated, or
            # hard-deleted → not found). Their saved week stays on the sheet
            # (Table view shows the progress under Unassigned) but the Cards
            # view hides the person — a binned account shouldn't keep a card.
            for e in entries:
                uid = e.get("user_id")
                if uid:
                    e["user_active"] = bool(active_map.get(uid, False))
        except Exception:
            pass

    # Hierarchy-based sort matching the office's printed bells sheet (Apr 2026):
    # Within each parent's children, emit "leaves" (no children of their own)
    # FIRST — sorted newest-joined first (closer to the leader) — followed by
    # "branches" (have children), each immediately followed inline by their
    # entire sub-tree applied recursively. This places newer trainees right
    # under the leader and pushes deep team hierarchies to the bottom.
    # Users without a user_id (legacy rows) fall to the bottom alphabetically.
    new_hire_starts: dict = {}
    try:
        async for h in db.new_hires.find({"office_id": office_id}, {"trainee_user_id": 1, "start_date": 1}):
            if h.get("trainee_user_id"):
                new_hire_starts[str(h["trainee_user_id"])] = h.get("start_date")
    except Exception:
        pass
    user_created_at: dict = {}
    if existing_uids or True:
        try:
            async for u in db.users.find(
                {"office_id": office_id},
                {"_id": 1, "created_at": 1},
            ):
                user_created_at[str(u["_id"])] = u.get("created_at")
        except Exception:
            pass

    def _join_key(uid: str):
        # Prefer the new_hire start_date (most accurate "joined" anchor for
        # trainees), fall back to user.created_at. Sort DESC: newest first.
        # Returned string sorts naturally in ISO 8601 format.
        return new_hire_starts.get(uid) or user_created_at.get(uid) or ""

    # ─── Team enrichment ────────────────────────────────────────────────────
    # See _enrich_entries_with_teams() docstring.
    await _enrich_entries_with_teams(entries)

    # Why each AB was granted + who approved it, for the table's AB popover.
    await _attach_absence_details(entries, office_id, week_ending)

    # ─── Section-aware hierarchy sort ──────────────────────────────────────
    # See _section_aware_sort() docstring. Section leader pinned at top,
    # then leaves-first/branches-after walk applied to each section.
    entries = _section_aware_sort(entries, reports_to_map, _join_key, role_map)

    # Count prior weeks on bells per user — used for the 4-week minimum before
    # the traffic light activates (one aggregation, not N per-user queries).
    prior_week_counts: dict = {}
    async for r in db.bells_entries.aggregate([
        {"$match": {"office_id": office_id, "week_ending": {"$lt": week_ending}}},
        {"$group": {"_id": "$user_id", "count": {"$sum": 1}}},
    ]):
        if r.get("_id"):
            prior_week_counts[r["_id"]] = r["count"]

    # Previous week lookup for LW column
    prev_week = _prev_sunday_iso(week_ending)
    prev_rows = {}
    prev_prev_rows = {}
    if prev_week:
        async for pe in db.bells_entries.find(
            {"office_id": office_id, "week_ending": prev_week},
            {"_id": 0, "user_id": 1, "user_name": 1, "days": 1},
        ):
            totals = compute_totals(pe, None)
            key = pe.get("user_id") or (pe.get("user_name") or "").strip().lower()
            prev_rows[key] = totals["total_sales"]
        # Two-weeks-ago lookup — drives "darker red" traffic light (2nd consecutive low week)
        prev_prev_week = _prev_sunday_iso(prev_week)
        if prev_prev_week:
            async for ppe in db.bells_entries.find(
                {"office_id": office_id, "week_ending": prev_prev_week},
                {"_id": 0, "user_id": 1, "user_name": 1, "days": 1},
            ):
                totals = compute_totals(ppe, None)
                key = ppe.get("user_id") or (ppe.get("user_name") or "").strip().lower()
                prev_prev_rows[key] = totals["total_sales"]

    # Fetch fees for earnings calc
    fees = await db.commission_fees.find_one({"office_id": office_id}, {"_id": 0})
    if not fees:
        fees = await db.commission_fees.find_one({}, {"_id": 0})

    office_doc = await db.offices.find_one({"id": office_id}, {"_id": 0, "name": 1})

    enriched = []
    sum_totals = {"total_over30": 0, "total_under30": 0, "total_memberships": 0, "total_sales": 0, "days_worked": 0, "earnings": 0.0}
    office_daily_totals = [0, 0, 0, 0, 0, 0, 0]
    # Office-level scoring (% of in-days that had ≥1 sale) — accumulators
    in_days_total = 0
    in_days_with_sale = 0
    # Green % = share of reps (with any in-day this week) who hit a Green Week (GREEN_WEEK_SALES+ sign-ups)
    reps_active = 0
    reps_green = 0
    for e in entries:
        t = compute_totals(e, fees)
        e.update(t)
        key = e.get("user_id") or (e.get("user_name") or "").strip().lower()
        if e.get("last_week_total") is None:
            prev_val = prev_rows.get(key)
            if prev_val is not None:
                e["last_week_total"] = prev_val
                e["last_week_total_source"] = "auto"
        if e.get("last_week_total") is not None and not e.get("last_week_total_source"):
            e["last_week_total_source"] = "manual"
        # Two-weeks-ago total for traffic-light "darker red" (2nd consecutive low week)
        e["prev_prev_week_total"] = prev_prev_rows.get(key)
        # Prior weeks on bells — traffic light activates at 4+
        uid = e.get("user_id")
        e["prior_weeks"] = prior_week_counts.get(uid, 0) if uid else 0
        enriched.append(e)
        for k in ("total_over30", "total_under30", "total_memberships", "total_sales", "days_worked"):
            sum_totals[k] += t[k]
        sum_totals["earnings"] += t["earnings"]
        # Accumulate per-day sales across the whole office
        for i, v in enumerate(t.get("daily_totals") or []):
            if i < 7:
                office_daily_totals[i] += int(v or 0)
        # Scoring + green tracking — only count reps with at least 1 in-day
        e_in_days = sum(1 for d in (e.get("days") or []) if _is_in_day(d))
        e_in_days_with_sale = sum(
            1 for d in (e.get("days") or [])
            if _is_in_day(d) and (int(_safe_num(d.get("over30")) + _safe_num(d.get("under30"))) > 0)
        )
        in_days_total += e_in_days
        in_days_with_sale += e_in_days_with_sale
        if e_in_days > 0:
            reps_active += 1
            if int(t.get("total_sales") or 0) >= GREEN_WEEK_SALES:
                reps_green += 1

    sum_totals["piece_average"] = round(sum_totals["total_sales"] / sum_totals["days_worked"], 2) if sum_totals["days_worked"] > 0 else 0.0
    sum_totals["average_earnings_per_day"] = round(sum_totals["earnings"] / sum_totals["days_worked"], 2) if sum_totals["days_worked"] > 0 else 0.0
    sum_totals["earnings"] = round(sum_totals["earnings"], 2)
    sum_totals["daily_totals"] = office_daily_totals
    # % of sales >30 / <30 / membership add-on. Denominator = total_sales.
    sum_totals["pct_over30"] = (
        round((sum_totals["total_over30"] / sum_totals["total_sales"]) * 100)
        if sum_totals["total_sales"] > 0 else 0
    )
    # Gold % = the SHORTER (<30) calls' share of total sales
    sum_totals["pct_under30"] = (
        round((sum_totals["total_under30"] / sum_totals["total_sales"]) * 100)
        if sum_totals["total_sales"] > 0 else 0
    )
    sum_totals["pct_memberships"] = (
        round((sum_totals["total_memberships"] / sum_totals["total_sales"]) * 100)
        if sum_totals["total_sales"] > 0 else 0
    )
    # Whole-downline totals, now that every entry has its total_sales, so a
    # crew goal can be shown against the crew it actually covers.
    _attach_team_subtree_sales(enriched, reports_to_map)
    # Scoring % = share of in-days that produced ≥1 sale
    sum_totals["scoring_pct"] = (
        round((in_days_with_sale / in_days_total) * 100)
        if in_days_total > 0 else 0
    )
    # Green % = share of active reps (≥1 in-day this week) who hit GREEN_WEEK_SALES+ sign-ups
    sum_totals["green_pct"] = (
        round((reps_green / reps_active) * 100)
        if reps_active > 0 else 0
    )
    sum_totals["reps_active"] = reps_active
    sum_totals["reps_green"] = reps_green

    # Who each person reports to and the stage they hold, for the sheet's
    # Coach and Stage columns.
    people: dict = {}
    ids = {e["user_id"] for e in enriched if e.get("user_id")}
    ids |= {str(v) for v in reports_to_map.values() if v}
    try:
        async for u in db.users.find(
            {"_id": {"$in": [ObjectId(i) for i in ids if ObjectId.is_valid(str(i))]}},
            {"_id": 1, "name": 1, "owneriq_stage": 1},
        ):
            people[str(u["_id"])] = u
    except Exception as _e:
        logger.warning(f"bells: coach/stage lookup failed: {_e}")
    # The office's (MC's) fees per sign-up: an Admin's figure only.
    show_mc = user.get("role") == "admin"
    for e in enriched:
        uid = e.get("user_id")
        coach_id = reports_to_map.get(uid) if uid else None
        e["coach_name"] = (people.get(str(coach_id)) or {}).get("name") if coach_id else None
        e["stage_label"] = _stage_label((people.get(uid) or {}).get("owneriq_stage")) if uid else None
        if show_mc:
            e["mc_fees"] = mc_fees(e.get("total_sales"), fees)
    if show_mc:
        sum_totals["mc_fees"] = mc_fees(sum_totals["total_sales"], fees)
        sum_totals["fee_mc"] = normalize_fees(fees)["fee_mc"]

    return {
        "week_ending": week_ending,
        "previous_week_ending": prev_week,
        "office_id": office_id,
        "office_name": (office_doc or {}).get("name"),
        "entries": enriched,
        "office_totals": sum_totals,
        "mini_team_goal": await mini_team_goal(office_id, week_ending),
    }


@router.post("/bells")
async def upsert_bell(request: Request):
    """Create or update a single person's weekly entry (upsert by office+user+week)."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")

    body = await request.json()
    week_ending = _validate_week_ending_write(body.get("week_ending") or "")

    user_name = (body.get("user_name") or "").strip()
    if not user_name:
        raise HTTPException(status_code=400, detail="user_name is required")

    # Super admins may select a validated office; everyone else is pinned to
    # their account's office by the shared resolver.
    office_id = await resolve_office_id(request, user, body.get("office_id"))
    if not office_id:
        raise HTTPException(status_code=400, detail="Office unknown")

    user_id = (body.get("user_id") or "").strip() or None
    target_query: dict = {
        "deleted": {"$ne": True},
        "is_active": {"$ne": False},
    }
    if user_id:
        try:
            target_query["_id"] = ObjectId(user_id)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid user_id")
    else:
        # Legacy entries sometimes carry only a name. Resolve that name inside
        # the selected office instead of trusting it as a free-form identity.
        target_query.update({"name": user_name, "office_id": office_id})
    target_user = await db.users.find_one(target_query, {"name": 1, "role": 1, "office_id": 1})
    # Someone let go before the sheet caught up still has a week row with a
    # day or two missing. An admin may finish that EXISTING row; nobody may
    # start a new one for a binned account, and the account stays binned.
    inactive_target = False
    if not target_user and user_id and (user.get("role") == "admin" or user.get("is_super_admin")):
        target_user = await db.users.find_one(
            {"_id": ObjectId(user_id), "office_id": office_id},
            {"name": 1, "role": 1, "office_id": 1},
        )
        if target_user and await db.bells_entries.find_one(
            {"office_id": office_id, "week_ending": week_ending, "user_id": user_id}, {"_id": 1}
        ):
            inactive_target = True
        else:
            target_user = None
    if not target_user:
        raise HTTPException(status_code=400, detail="Active user not found")
    if target_user.get("office_id") != office_id:
        raise HTTPException(status_code=403, detail="User belongs to a different office")
    user_id = str(target_user["_id"])
    user_name = (target_user.get("name") or "").strip()
    if not user_name:
        raise HTTPException(status_code=409, detail="User has no display name")

    # Subtree enforcement: non-admin leaders may only write entries for themselves
    # or users in their team subtree. Admins (including super admins) are unrestricted.
    if user.get("role") == "leader" and not user.get("is_super_admin"):
        if not user_id:
            raise HTTPException(
                status_code=400,
                detail="user_id is required when updating a bell as a coach.",
            )
        try:
            allowed_ids = set(await get_subtree_ids(user["id"]))
        except Exception:
            allowed_ids = set()
        # Subtree helper typically includes the leader themselves, but be explicit to be safe
        allowed_ids.add(str(user["id"]))
        if str(user_id) not in allowed_ids:
            raise HTTPException(
                status_code=403,
                detail="You can only update your own or your team's weekly entries.",
            )
    days = _normalize_days(body.get("days"))
    # Derive role from the user record if we have one (for tier mapping)
    role = target_user.get("role")
    stage_raw = body.get("stage")
    stage = int(stage_raw) if stage_raw not in (None, "") and str(stage_raw).isdigit() else None
    break_even = _num_or_none(body.get("break_even"))
    weekly_goal = _num_or_none(body.get("weekly_goal"))
    last_week_total = _num_or_none(body.get("last_week_total"))
    # Track whether the LW came from the admin's hand or from auto-fill so
    # the UI can label it. "manual" wins; if blank we look up the previous
    # week and snapshot it server-side.
    last_week_total_source: Optional[str] = "manual" if last_week_total is not None else None
    if last_week_total is None:
        prev_week = _prev_sunday_iso(week_ending)
        if prev_week:
            prev_filt: dict = {"office_id": office_id, "week_ending": prev_week}
            # Match by user_id when known, otherwise by user_name
            if user_id:
                prev_filt["user_id"] = user_id
            else:
                prev_filt["user_name"] = user_name
            prev_doc = await db.bells_entries.find_one(prev_filt, {"_id": 0, "days": 1})
            if prev_doc:
                prev_totals = compute_totals(prev_doc, None)
                if prev_totals.get("total_sales"):
                    last_week_total = int(prev_totals["total_sales"])
                    last_week_total_source = "auto"

    # Find existing row — key is (office + week + user_id if present else user_name)
    filt = {"office_id": office_id, "week_ending": week_ending}
    if user_id:
        filt["user_id"] = user_id
    else:
        filt["user_name"] = user_name
        filt["user_id"] = None

    now_iso = datetime.now(timezone.utc).isoformat()
    # Fetch fees before saving so we can persist earnings on the document
    fees = await db.commission_fees.find_one({"office_id": office_id}, {"_id": 0})
    if not fees:
        fees = await db.commission_fees.find_one({}, {"_id": 0})

    existing = await db.bells_entries.find_one(filt, {"_id": 0})

    # ── Absence guard (non-admins) ───────────────────────────────────────
    # Marking someone Ab (or clearing an Ab) is the office owner's call —
    # leaders request absences via the Weekly Planner and the owner approves
    # (routes/absences.py). So for non-admin callers any day-status change
    # to or from 'ab' is silently reverted to what's on the sheet; every
    # other field (sales numbers, in/off/rt/nc/pc, BE, WG) saves normally.
    # This is what makes passcode-free self-reporting safe.
    absence_changes_blocked = False
    if user.get("role") != "admin" and not user.get("is_super_admin"):
        existing_days = _normalize_days((existing or {}).get("days"))
        for i in range(min(len(days), len(existing_days))):
            cur_s = existing_days[i].get("status")
            new_s = days[i].get("status")
            if new_s == "ab" and cur_s != "ab":
                days[i]["status"] = cur_s
                # An Ab attempt wipes the day's numbers client-side; restore them.
                for k in ("over30", "under30", "memberships"):
                    days[i][k] = existing_days[i].get(k)
                absence_changes_blocked = True
            elif cur_s == "ab" and new_s != "ab":
                days[i] = dict(existing_days[i])
                absence_changes_blocked = True

    if not existing:
        entry = {
            "id": str(uuid.uuid4()),
            "office_id": office_id,
            "user_id": user_id,
            "user_name": user_name,
            "role": role,
            "stage": stage,
            "break_even": break_even,
            "weekly_goal": weekly_goal,
            "last_week_total": last_week_total,
            "last_week_total_source": last_week_total_source,
            "week_ending": week_ending,
            "days": days,
            "created_by_id": user["id"],
            "created_at": now_iso,
            "updated_at": now_iso,
        }
        entry["earnings"] = compute_totals(entry, fees).get("earnings", 0.0)
        try:
            await db.bells_entries.insert_one(entry.copy())
        except DuplicateKeyError:
            # Lost the create race (uniq_office_week_user): a concurrent
            # writer inserted this week row between our find_one and the
            # insert. Fall through and write the payload onto the winner —
            # a second row splits the week between the grid (which shows one
            # duplicate) and every writer (which updates the other).
            existing = await db.bells_entries.find_one(filt, {"_id": 0})

    if existing:
        update = {
            "user_name": user_name,
            "role": role,
            "stage": stage,
            "break_even": break_even,
            "weekly_goal": weekly_goal,
            "last_week_total": last_week_total,
            "last_week_total_source": last_week_total_source,
            "days": days,
            "updated_at": now_iso,
        }
        # Captured before `existing` is mutated below — this path replaces the
        # whole row from the client payload, so it can move a goal without
        # anyone intending to (the sheet just resends whatever it had loaded).
        prev_goal = existing.get("weekly_goal")
        if weekly_goal != prev_goal:
            # A goal typed in the app stays: the OwnerIQ sync only fills a
            # goal nobody here has set (owneriq_performance: it writes while
            # the source is "owneriq" or the goal is empty).
            update["weekly_goal_source"] = "app" if weekly_goal is not None else None
        existing.update(update)
        update["earnings"] = compute_totals(existing, fees).get("earnings", 0.0)
        await db.bells_entries.update_one({"id": existing["id"]}, {"$set": update})
        existing["earnings"] = update["earnings"]
        entry = existing
        await record_goal_change(
            db, user_id=user_id, week_ending=week_ending, field="weekly_goal",
            old=prev_goal, new=weekly_goal, actor=user, source="POST /bells",
        )

    # Enrich with all derived totals before returning
    entry.update(compute_totals(entry, fees))
    entry.pop("_id", None)
    if absence_changes_blocked:
        entry["absence_changes_blocked"] = True

    # If this entry has any sale and belongs to a linked user, mark them as a
    # BA who's done a sale. Only stamp first_sale_at once (never overwrite it).
    if user_id and not inactive_target:
        has_any_sale = any(
            d.get("status") == "in"
            and (d.get("over30") or 0) + (d.get("under30") or 0) > 0
            for d in days
        )
        if has_any_sale:
            try:
                from bson import ObjectId as _ObjId
                sale_update: dict = {"has_made_sale": True}
                u_doc = await db.users.find_one({"_id": _ObjId(user_id)}, {"_id": 0, "first_sale_at": 1})
                if u_doc is not None and not u_doc.get("first_sale_at"):
                    sale_update["first_sale_at"] = datetime.now(timezone.utc).isoformat()
                await db.users.update_one({"_id": _ObjId(user_id)}, {"$set": sale_update})
            except Exception as _e:
                logger.warning(f"upsert_bell: could not mark has_made_sale for user {user_id}: {_e}")
            try:
                await award_sales_milestones(user_id, days)
            except Exception as _e:
                logger.warning(f"upsert_bell: achievement award failed for user {user_id}: {_e}")

    # Reconcile AFTER the award pass and OUTSIDE the has_any_sale guard: a
    # correction that removes a rep's only 5-sale day leaves the week with no
    # sales at all, and that is exactly when a stale First Gong (or a team tier
    # up the line) needs pulling. Silent revoke, self-healing from the board.
    if user_id and not inactive_target:
        try:
            revoked = await reconcile_sales_and_team_badges(user_id)
            if revoked:
                logger.info(f"upsert_bell: revoked stale badges after correction: {revoked}")
        except Exception as _e:
            logger.warning(f"upsert_bell: badge reconcile failed for user {user_id}: {_e}")

    # Sales-path recompute — also OUTSIDE the has_any_sale guard: a saved
    # zero-sale week is exactly the event that must flip a new hire's ramp
    # to 'behind'. No-op while the feature flag is off for this office.
    if user_id and not inactive_target:
        try:
            from core.sales_path import recompute_sales_path
            await recompute_sales_path(user_id)
        except Exception as _e:
            logger.warning(f"upsert_bell: sales-path recompute failed for user {user_id}: {_e}")

    return entry


@router.put("/bells/my-weekly-goal")
async def set_my_weekly_goal(request: Request):
    """Set the CALLER's own personal weekly sales goal for the current bells
    week — the number a leader's Team pulse compares against. Deliberately
    narrow: only touches the `weekly_goal` field via $set, never `days`, so
    it's safe to call from a quick inline prompt without risking clobbering
    anyone's already-entered sales for the week (unlike POST /bells, which
    replaces the whole days array from whatever the caller sends)."""
    user = await get_current_user(request)
    office_id = user.get("office_id")
    if not office_id:
        raise HTTPException(status_code=400, detail="Office unknown")
    body = await request.json()
    goal = _num_or_none(body.get("weekly_goal"))

    today_uk = datetime.now(APP_TZ).date()
    week_ending = (today_uk + timedelta(days=(6 - today_uk.weekday()))).isoformat()

    now_iso = datetime.now(timezone.utc).isoformat()
    existing = await db.bells_entries.find_one(
        {"office_id": office_id, "week_ending": week_ending, "user_id": user["id"]}
    )
    if existing:
        await db.bells_entries.update_one(
            # "app": a goal set here stays; the OwnerIQ sync won't replace it.
            {"id": existing["id"]}, {"$set": {"weekly_goal": goal, "weekly_goal_source": "app" if goal is not None else None,
                                               "updated_at": now_iso}}
        )
    else:
        try:
            await db.bells_entries.insert_one({
                "id": str(uuid.uuid4()),
                "office_id": office_id,
                "user_id": user["id"],
                "user_name": user.get("name", ""),
                "role": user.get("role"),
                "stage": None,
                "break_even": None,
                "weekly_goal": goal,
                "last_week_total": None,
                "last_week_total_source": None,
                "week_ending": week_ending,
                "days": _normalize_days([]),
                "created_by_id": user["id"],
                "created_at": now_iso,
                "updated_at": now_iso,
            })
        except DuplicateKeyError:
            # Lost the create race (uniq_office_week_user) — set the goal on
            # the winner's row instead of leaving a second row for the week.
            existing = await db.bells_entries.find_one(
                {"office_id": office_id, "week_ending": week_ending, "user_id": user["id"]}
            )
            if existing:
                await db.bells_entries.update_one(
                    # "app": a goal set here stays; the OwnerIQ sync won't replace it.
            {"id": existing["id"]}, {"$set": {"weekly_goal": goal, "weekly_goal_source": "app" if goal is not None else None,
                                               "updated_at": now_iso}}
                )
    await record_goal_change(
        db, user_id=user["id"], week_ending=week_ending, field="weekly_goal",
        old=(existing or {}).get("weekly_goal"), new=goal, actor=user,
        source="PUT /bells/my-weekly-goal",
    )
    return {"week_ending": week_ending, "weekly_goal": goal}


# ── Mini Vertex ──────────────────────────────────────────────────────────────
# The people who aren't in a named team yet sit together on the sheet as
# "Mini Vertex". A named team's goal lives on its Coach's bells row; Mini
# Vertex has no Coach of its own, so its weekly goal is kept per office and
# week in `bells_group_goals`.

def _mini_goal_id(office_id: str, week_ending: str) -> str:
    return f"{office_id}:{week_ending}:mini"


async def mini_team_goal(office_id: str, week_ending: str):
    doc = await db.bells_group_goals.find_one({"_id": _mini_goal_id(office_id, week_ending)})
    return (doc or {}).get("goal")


@router.put("/bells/mini-team-goal")
async def set_mini_team_goal(request: Request):
    """Admin: set (or clear) Mini Vertex's sign-up goal for a week.
    Body: {goal: number | null, week_ending?: 'YYYY-MM-DD', office?: id}."""
    user = await get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    body = await request.json()
    goal = _num_or_none(body.get("goal"))
    office_id = (body.get("office") if user.get("is_super_admin") else None) or user.get("office_id")
    if not office_id:
        raise HTTPException(status_code=400, detail="Office unknown")
    week_ending = _validate_week_ending_write(body.get("week_ending")) if body.get("week_ending") else None
    if not week_ending:
        today_uk = datetime.now(APP_TZ).date()
        week_ending = (today_uk + timedelta(days=(6 - today_uk.weekday()))).isoformat()
    key = _mini_goal_id(office_id, week_ending)
    if goal is None:
        await db.bells_group_goals.delete_one({"_id": key})
    else:
        await db.bells_group_goals.update_one({"_id": key}, {"$set": {
            "office_id": office_id, "week_ending": week_ending, "goal": goal,
            "updated_by": user["id"], "updated_at": datetime.now(timezone.utc).isoformat()}}, upsert=True)
    return {"week_ending": week_ending, "goal": goal}


@router.put("/bells/team-weekly-goal")
async def set_team_weekly_goal(request: Request):
    """Set a CREW's weekly sales goal — the whole-team target. Lives as
    `team_weekly_goal` on the section leader's own bells row, which is the
    single source every surface reads: the Bells team header, the public
    live sheet, the Home Team pulse, and the Weekly Planner's team-goal box
    (PUT /weekly-planners/my-goals writes the same field). Leaders set their
    own crew's goal; admins may set any leader's in their office by passing
    user_id. Optional week_ending targets a specific week (defaults to the
    current bells week). $set-only — never touches `days`."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    body = await request.json()
    goal = _num_or_none(body.get("team_weekly_goal"))

    target_id = str(body.get("user_id") or "").strip() or user["id"]
    target_office = user.get("office_id")
    target_name = user.get("name", "")
    target_role = user.get("role")
    if target_id != user["id"]:
        if user.get("role") != "admin" and not user.get("is_super_admin"):
            raise HTTPException(status_code=403, detail="Only admins can set another coach's crew goal")
        try:
            tdoc = await db.users.find_one({"_id": ObjectId(target_id)})
        except Exception:
            tdoc = None
        if not tdoc or tdoc.get("deleted"):
            raise HTTPException(status_code=404, detail="User not found")
        if not user.get("is_super_admin") and (tdoc.get("office_id") or "") != (user.get("office_id") or ""):
            raise HTTPException(status_code=403, detail="That coach is in a different office")
        target_office = tdoc.get("office_id")
        target_name = tdoc.get("name", "")
        target_role = tdoc.get("role")
    if not target_office:
        raise HTTPException(status_code=400, detail="Office unknown")

    week_ending = _validate_week_ending_write(body.get("week_ending")) if body.get("week_ending") else None
    if not week_ending:
        today_uk = datetime.now(APP_TZ).date()
        week_ending = (today_uk + timedelta(days=(6 - today_uk.weekday()))).isoformat()

    now_iso = datetime.now(timezone.utc).isoformat()
    existing = await db.bells_entries.find_one(
        {"office_id": target_office, "week_ending": week_ending, "user_id": target_id}
    )
    if existing:
        await db.bells_entries.update_one(
            {"id": existing["id"]}, {"$set": {"team_weekly_goal": goal, "updated_at": now_iso}}
        )
    else:
        try:
            await db.bells_entries.insert_one({
                "id": str(uuid.uuid4()),
                "office_id": target_office,
                "user_id": target_id,
                "user_name": target_name,
                "role": target_role,
                "stage": None,
                "break_even": None,
                "weekly_goal": None,
                "team_weekly_goal": goal,
                "last_week_total": None,
                "last_week_total_source": None,
                "week_ending": week_ending,
                "days": _normalize_days([]),
                "created_by_id": user["id"],
                "created_at": now_iso,
                "updated_at": now_iso,
            })
        except DuplicateKeyError:
            # Lost the create race (uniq_office_week_user) — set the crew goal
            # on the winner's row instead of leaving a second row for the week.
            existing = await db.bells_entries.find_one(
                {"office_id": target_office, "week_ending": week_ending, "user_id": target_id}
            )
            if existing:
                await db.bells_entries.update_one(
                    {"id": existing["id"]}, {"$set": {"team_weekly_goal": goal, "updated_at": now_iso}}
                )
    await record_goal_change(
        db, user_id=target_id, week_ending=week_ending, field="team_weekly_goal",
        old=(existing or {}).get("team_weekly_goal"), new=goal, actor=user,
        source="PUT /bells/team-weekly-goal",
    )
    # An OFFICE-LEVEL admin's crew IS the office — mirror their crew goal onto
    # the Weekly Plan's Sales Goal + the office doc (and any co-admin's row) so
    # Bells and the plan always show the same number (owner request, Sep 2026).
    # An admin who runs their own crew inside the office (core/admin_scope.py)
    # is skipped: publishing one team's target as the whole office's is exactly
    # the bug this guard exists to prevent.
    if (target_role or "").lower() == "admin":
        from core.admin_scope import leads_own_crew_by_id
        if not await leads_own_crew_by_id(target_id):
            from core.goal_sync import sync_office_weekly_goal
            await sync_office_weekly_goal(
                target_office, week_ending, goal, user, "PUT /bells/team-weekly-goal",
                skip_bells_user_id=target_id,
            )
    return {"week_ending": week_ending, "team_weekly_goal": goal, "user_id": target_id}


def _month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


@router.get("/bells/my-summary")
async def my_bells_summary(request: Request, week: Optional[str] = None, months: int = 6):
    """The caller's OWN sign-ups, for the Pay tab — open to every role
    (GET /bells is leaders/admins only, but a trainee's own numbers are theirs).

    Returns this week's £12 / £15+ counts from their Bells row plus sign-ups
    per calendar month for the last `months` months (current month included),
    each day counted in the month it falls in (a week can straddle two
    months). Read-only; the office's fee knobs ride along so the Pay tab can
    price the week with one round-trip."""
    user = await get_current_user(request)
    uid = str(user.get("id") or "")
    if not uid:
        raise HTTPException(status_code=400, detail="User unknown")
    months = max(1, min(int(months or 6), 24))

    today = datetime.now(APP_TZ).date()
    if week:
        week_ending = _coerce_to_sunday(week)
        if not week_ending:
            raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
    else:
        week_ending = (today + timedelta(days=(6 - today.weekday()) % 7)).isoformat()

    # Month buckets, oldest first, ending with the current month.
    keys = [
        "%04d-%02d" % _add_months(today.year, today.month, -i)
        for i in range(months - 1, -1, -1)
    ]
    first_y, first_m = (int(x) for x in keys[0].split("-"))
    earliest_week = (date(first_y, first_m, 1) - timedelta(days=7)).isoformat()
    buckets = {k: {"month": k, "standard": 0, "target": 0, "sign_ups": 0, "weeks": 0} for k in keys}

    this_week: Optional[dict] = None
    async for e in db.bells_entries.find(
        {"user_id": uid, "week_ending": {"$gte": min(earliest_week, week_ending)}},
        {"_id": 0},
    ):
        we = e.get("week_ending") or ""
        try:
            we_date = datetime.strptime(we, "%Y-%m-%d").date()
        except ValueError:
            continue
        if we == week_ending:
            this_week = e
        seen: set = set()
        for i, d in enumerate((e.get("days") or [])[:7]):
            if not isinstance(d, dict):
                continue
            key = _month_key(we_date - timedelta(days=6 - i))
            b = buckets.get(key)
            if b is None:
                continue
            u = int(_safe_num(d.get("under30")))
            o = int(_safe_num(d.get("over30")))
            b["standard"] += u
            b["target"] += o
            b["sign_ups"] += u + o
            seen.add(key)
        for key in seen:
            buckets[key]["weeks"] += 1

    fees_doc = None
    office_id = user.get("office_id")
    if office_id:
        fees_doc = await db.commission_fees.find_one({"office_id": office_id}, {"_id": 0})
    if not fees_doc:
        fees_doc = await db.commission_fees.find_one({}, {"_id": 0})
    fees = normalize_fees(fees_doc)

    t = compute_totals(this_week or {"days": []}, fees)
    return {
        "week_ending": week_ending,
        "has_entry": this_week is not None,
        "this_week": {
            "standard": t["total_under30"],
            "target": t["total_over30"],
            "sign_ups": t["total_sales"],
            "days_worked": t["days_worked"],
            "earnings": t["earnings"],
        },
        "months": [buckets[k] for k in keys],
        "fees": fees,
    }


@router.post("/admin/bells/backfill-earnings")
async def backfill_bells_earnings(request: Request):
    """Recompute and persist earnings on every bells_entry that is missing it.
    Safe to run multiple times — only writes when the stored value differs."""
    user = await require_super_admin(request)
    _ = user

    # Cache fees per office to avoid N queries
    fees_cache: dict = {}
    async for f in db.commission_fees.find({}, {"_id": 0}):
        fees_cache[f.get("office_id", "__default__")] = f
    default_fees = fees_cache.get("__default__") or next(iter(fees_cache.values()), None)

    updated = 0
    skipped = 0
    async for entry in db.bells_entries.find({}, {"_id": 0}):
        office_id = entry.get("office_id", "")
        fees = fees_cache.get(office_id) or default_fees
        computed = compute_totals(entry, fees)
        new_earnings = round(float(computed.get("earnings") or 0), 2)
        if round(float(entry.get("earnings") or 0), 2) == new_earnings:
            skipped += 1
            continue
        await db.bells_entries.update_one(
            {"id": entry["id"]},
            {"$set": {"earnings": new_earnings}},
        )
        updated += 1

    return {"updated": updated, "skipped": skipped}


@router.delete("/bells/{entry_id}")
async def delete_bell(entry_id: str, request: Request):
    """Remove a weekly entry (office-scoped)."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    entry = await db.bells_entries.find_one({"id": entry_id})
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    if not user.get("is_super_admin") and entry.get("office_id") != user.get("office_id"):
        raise HTTPException(status_code=403, detail="This entry belongs to a different office")
    if not await _leader_can_touch_bell(user, entry):
        raise HTTPException(status_code=403, detail="You can only delete your own or your team's entries")
    await db.bells_entries.delete_one({"id": entry_id})
    return {"message": "Entry deleted"}


@router.post("/bells/clear-day")
async def clear_bells_day(request: Request):
    """Mark every rep's entry for a given day as off (null sales).

    Useful when a WhatsApp paste was applied to the wrong date — wipes the
    day so it can be re-parsed without manually editing each row.

    Body: { week_ending: "YYYY-MM-DD", day_index: 0-6 }  (0 = Mon … 6 = Sun)
    """
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    body = await request.json()
    raw_week = (body.get("week_ending") or "").strip()
    day_index = body.get("day_index")
    if not raw_week or day_index is None:
        raise HTTPException(status_code=400, detail="week_ending and day_index are required")
    week_ending = _validate_week_ending_write(raw_week)
    if not isinstance(day_index, int) or not (0 <= day_index <= 6):
        raise HTTPException(status_code=400, detail="day_index must be 0-6")

    office_id = (
        (body.get("office_id") or "").strip()
        if user.get("is_super_admin")
        else user.get("office_id") or ""
    ) or user.get("office_id") or ""
    if not office_id:
        raise HTTPException(status_code=400, detail="Office unknown")
    query: dict = {"week_ending": week_ending, "office_id": office_id}
    if user.get("role") == "leader" and not user.get("is_super_admin"):
        allowed = set(await get_subtree_ids(user["id"]))
        allowed.add(str(user["id"]))
        query["user_id"] = {"$in": list(allowed)}

    # For each matching entry, null out that day's sales and mark it off.
    cleared = 0
    async for entry in db.bells_entries.find(query, {"_id": 1, "days": 1}):
        days = entry.get("days") or []
        if day_index >= len(days):
            continue
        days[day_index] = {**days[day_index], "status": "off", "over30": None, "under30": None, "memberships": None}
        await db.bells_entries.update_one(
            {"_id": entry["_id"]},
            {"$set": {f"days.{day_index}": days[day_index]}},
        )
        cleared += 1

    return {"cleared": cleared, "week_ending": week_ending, "day_index": day_index}


@router.get("/bells/teams")
async def list_bells_teams(request: Request, week: Optional[str] = None, office: Optional[str] = None):
    """Aggregate bells entries by TEAM for a given week. A team is rooted at a leader
    with a non-empty team_name; members = the leader + their entire subtree.

    Returns per-team KPIs: total sales / weekly avg / piece avg / scoring % / earnings /
    member count / working today / vs last week delta.
    """
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    if user.get("is_super_admin") and office:
        office_id = office
    else:
        office_id = user.get("office_id") or ""
    if not office_id:
        return {"week_ending": None, "previous_week_ending": None, "teams": []}

    if week:
        coerced = _coerce_to_sunday(week)
        if not coerced:
            raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
        week_ending = coerced
    else:
        today = datetime.now(APP_TZ).date()
        offset = (today.weekday() - 6) % 7
        week_ending = (today - timedelta(days=offset)).isoformat()

    prev_week = _prev_sunday_iso(week_ending)

    # Leaders/admins in this office who have set a team_name AND have at
    # least one direct report whose role == 'leader' (section-leader rule).
    # Without a sub-leader, a leader's people render inline in their parent's
    # section on the bells sheet — they shouldn't show as a separate Team
    # card here either, so we exclude them.
    raw_team_leaders = await db.users.find(
        {"office_id": office_id, "role": {"$in": ["leader", "admin"]}, "team_name": {"$nin": [None, ""]}, "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}},
        {"_id": 1, "name": 1, "team_name": 1},
    ).to_list(200)
    # Pull every direct child of these candidates in one round-trip
    candidate_ids = [tl["_id"] for tl in raw_team_leaders]
    sub_leaders_by_parent: dict = {}
    if candidate_ids:
        async for u in db.users.find(
            {"office_id": office_id, "reports_to": {"$in": [str(x) for x in candidate_ids]}, "role": "leader", "is_active": {"$ne": False}, "deleted": {"$ne": True}},
            {"_id": 1, "reports_to": 1},
        ):
            p = str(u.get("reports_to") or "")
            sub_leaders_by_parent.setdefault(p, []).append(str(u["_id"]))
    team_leaders = [
        tl for tl in raw_team_leaders
        if sub_leaders_by_parent.get(str(tl["_id"]))
    ]

    # Determine whether 'working today' is meaningful (only for current week)
    today_local = datetime.now(APP_TZ).date()
    current_week_end = (today_local + timedelta(days=(6 - today_local.weekday()) % 7)).isoformat()
    is_current_week = (week_ending == current_week_end)

    # Non-super-admin leaders only see teams within their subtree
    visibility_ids: Optional[set] = None
    if user.get("role") == "leader" and not user.get("is_super_admin"):
        try:
            sub = await get_subtree_ids(user["id"])
            visibility_ids = {str(x) for x in sub}
            visibility_ids.add(str(user["id"]))
        except Exception:
            visibility_ids = {str(user["id"])}
        team_leaders = [tl for tl in team_leaders if str(tl["_id"]) in visibility_ids]

    fees = await db.commission_fees.find_one({"office_id": office_id}, {"_id": 0}) or await db.commission_fees.find_one({}, {"_id": 0})

    teams_out: list = []
    for tl in team_leaders:
        leader_id = str(tl["_id"])
        try:
            member_ids = await get_subtree_ids(leader_id)
        except Exception:
            member_ids = []
        member_ids = [str(m) for m in member_ids]
        if visibility_ids is not None:
            member_ids = [m for m in member_ids if m in visibility_ids]
        if not member_ids:
            continue

        this_week = await db.bells_entries.find(
            {"office_id": office_id, "week_ending": week_ending, "user_id": {"$in": member_ids}},
            {"_id": 0},
        ).to_list(500)
        last_week = await db.bells_entries.find(
            {"office_id": office_id, "week_ending": prev_week, "user_id": {"$in": member_ids}},
            {"_id": 0},
        ).to_list(500) if prev_week else []

        def _aggregate(entries):
            t = {"sales": 0, "memberships": 0, "days_worked": 0, "earnings": 0.0,
                 "in_days": 0, "in_days_with_sale": 0, "in_day_sales": 0,
                 "working_today": 0, "members_with_entries": 0,
                 "over30": 0, "under30": 0}
            today_dow = today_local.weekday()  # Mon=0..Sun=6 — local server day
            for e in entries:
                tot = compute_totals(e, fees)
                t["sales"] += tot["total_sales"]
                t["over30"] += tot["total_over30"]
                t["under30"] += tot["total_under30"]
                t["memberships"] += tot["total_memberships"]
                t["days_worked"] += tot["days_worked"]
                t["earnings"] += tot["earnings"]
                for d in e.get("days") or []:
                    if d and d.get("status") == "in":
                        t["in_days"] += 1
                        s = int((d.get("over30") or 0) + (d.get("under30") or 0))
                        t["in_day_sales"] += s
                        if s > 0:
                            t["in_days_with_sale"] += 1
                has_data = any(
                    (d or {}).get("status") == "in" or
                    (d or {}).get("over30") or (d or {}).get("under30") or (d or {}).get("memberships")
                    for d in (e.get("days") or [])
                )
                if has_data:
                    t["members_with_entries"] += 1
                # Working today only meaningful when viewing the current week
                if is_current_week:
                    days = e.get("days") or []
                    if today_dow < len(days):
                        td = days[today_dow] or {}
                        if td.get("status") == "in":
                            t["working_today"] += 1
            t["piece_avg"] = round(t["in_day_sales"] / t["in_days"], 2) if t["in_days"] > 0 else 0.0
            t["scoring_pct"] = round((t["in_days_with_sale"] / t["in_days"]) * 100) if t["in_days"] > 0 else 0
            t["weekly_avg"] = round(t["sales"] / t["members_with_entries"], 2) if t["members_with_entries"] > 0 else 0.0
            # New: % >30 and % membership for the team
            t["pct_over30"] = round((t["over30"] / t["sales"]) * 100) if t["sales"] > 0 else 0
            t["pct_memberships"] = round((t["memberships"] / t["sales"]) * 100) if t["sales"] > 0 else 0
            return t

        this_agg = _aggregate(this_week)
        last_agg = _aggregate(last_week) if last_week else None
        sales_delta = this_agg["sales"] - (last_agg["sales"] if last_agg else 0)
        sales_delta_pct = (
            round(((this_agg["sales"] - last_agg["sales"]) / last_agg["sales"]) * 100)
            if last_agg and last_agg["sales"] > 0 else None
        )

        # Crew goal — team_weekly_goal off the section leader's own row, the
        # same field the Weekly Planner's team-goal box and the table-view
        # header editor write.
        leader_row = next((e for e in this_week if str(e.get("user_id") or "") == leader_id), None)

        teams_out.append({
            "leader_id": leader_id,
            "leader_name": tl.get("name"),
            "team_name": tl.get("team_name"),
            "team_weekly_goal": (leader_row or {}).get("team_weekly_goal"),
            "member_ids": member_ids,
            "member_count": len(member_ids),
            "total_sales": this_agg["sales"],
            "total_memberships": this_agg["memberships"],
            "days_worked": this_agg["days_worked"],
            "earnings": round(this_agg["earnings"], 2),
            "piece_average": this_agg["piece_avg"],
            "scoring_pct": this_agg["scoring_pct"],
            "weekly_average": this_agg["weekly_avg"],
            "working_today": this_agg["working_today"],
            "members_with_entries": this_agg["members_with_entries"],
            "pct_over30": this_agg["pct_over30"],
            "pct_memberships": this_agg["pct_memberships"],
            "last_week_total_sales": (last_agg["sales"] if last_agg else None),
            "sales_delta": sales_delta,
            "sales_delta_pct": sales_delta_pct,
        })

    teams_out.sort(key=lambda t: (-t["total_sales"], (t.get("team_name") or "").lower()))

    # Compute the OFFICE-wide totals (unique-entries) so the UI can show a
    # canonical "Total Sales" that doesn't double-count members who roll up
    # into multiple overlapping team subtrees.
    office_totals = {"sales": 0, "memberships": 0, "days_worked": 0, "earnings": 0.0,
                     "working_today": 0, "members_with_entries": 0,
                     "over30": 0, "under30": 0}
    try:
        all_entries = await db.bells_entries.find(
            {"office_id": office_id, "week_ending": week_ending},
            {"_id": 0},
        ).to_list(2000)
        if visibility_ids is not None:
            all_entries = [e for e in all_entries if (e.get("user_id") and str(e["user_id"]) in visibility_ids)]
        ts = office_totals
        for e in all_entries:
            tot = compute_totals(e, fees)
            ts["sales"] += tot["total_sales"]
            ts["over30"] += tot["total_over30"]
            ts["under30"] += tot["total_under30"]
            ts["memberships"] += tot["total_memberships"]
            ts["days_worked"] += tot["days_worked"]
            ts["earnings"] += tot["earnings"]
            has_data = any(
                (d or {}).get("status") == "in" or
                (d or {}).get("over30") or (d or {}).get("under30") or (d or {}).get("memberships")
                for d in (e.get("days") or [])
            )
            if has_data:
                ts["members_with_entries"] += 1
            # Working today only meaningful when viewing the current week
            if is_current_week:
                days = e.get("days") or []
                td_dow = today_local.weekday()
                if td_dow < len(days):
                    td = days[td_dow] or {}
                    if td.get("status") == "in":
                        ts["working_today"] += 1
        ts["earnings"] = round(ts["earnings"], 2)
        # New: % over30 + % membership
        ts["pct_over30"] = round((ts["over30"] / ts["sales"]) * 100) if ts["sales"] > 0 else 0
        ts["pct_memberships"] = round((ts["memberships"] / ts["sales"]) * 100) if ts["sales"] > 0 else 0
    except Exception:
        pass

    return {
        "week_ending": week_ending,
        "previous_week_ending": prev_week,
        "teams": teams_out,
        "office_totals": office_totals,
    }




@router.put("/bells/{entry_id}/visibility")
async def set_bell_visibility(entry_id: str, request: Request):
    """Hide or restore a single week's entry from the public bells sheet."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    body = await request.json()
    hidden = bool(body.get("hidden", False))
    entry = await db.bells_entries.find_one({"id": entry_id})
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    if not user.get("is_super_admin") and entry.get("office_id") != user.get("office_id"):
        raise HTTPException(status_code=403, detail="This entry belongs to a different office")
    if not await _leader_can_touch_bell(user, entry):
        raise HTTPException(status_code=403, detail="You can only change your own or your team's entries")
    await db.bells_entries.update_one({"id": entry_id}, {"$set": {"public_hidden": hidden}})
    return {"ok": True, "hidden": hidden}


@router.get("/bells/weeks")
async def list_bells_weeks(request: Request, office: Optional[str] = None):
    """Return a sorted list of weeks that have at least one entry (for prev-week picker)."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    if user.get("is_super_admin") and office:
        office_id = office
    else:
        office_id = user.get("office_id") or ""
    weeks = await db.bells_entries.distinct("week_ending", {"office_id": office_id})
    return {"weeks": sorted(weeks, reverse=True)}


@router.get("/bells/roster")
async def list_office_roster(request: Request, office: Optional[str] = None):
    """Helper: returns users in the office (for the 'add person to bells' picker).
    Leaders see only their subtree. Admins/super-admins see everyone in the office."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    if user.get("is_super_admin") and office:
        office_id = office
    else:
        office_id = user.get("office_id") or ""
    roster_q: dict = {"office_id": office_id, "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}}
    if user.get("role") == "leader" and not user.get("is_super_admin"):
        try:
            sub = await get_subtree_ids(user["id"])
            roster_q["_id"] = {"$in": [ObjectId(uid) for uid in sub]}
        except Exception:
            roster_q["_id"] = {"$in": []}
    rows = []
    async for u in db.users.find(
        roster_q,
        {"_id": 1, "name": 1, "email": 1, "role": 1},
    ).sort("name", 1):
        rows.append({"id": str(u["_id"]), "name": u.get("name") or u.get("email"), "email": u.get("email"), "role": u.get("role")})
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# Public Share — read-only per-office weekly URL (unlock code protected)
# ─────────────────────────────────────────────────────────────────────────────

def _slugify(s: str) -> str:
    """Convert office name to a URL-safe slug. 'North London' -> 'north-london'."""
    s = (s or "").strip().lower()
    out = []
    for ch in s:
        if ch.isalnum():
            out.append(ch)
        elif ch in " -_":
            out.append("-")
    slug = "".join(out)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-")


async def _find_office_by_slug(slug: str):
    """Find an office whose slug matches (derived from office name)."""
    if not slug:
        return None
    offices = await db.offices.find({}, {"_id": 0}).to_list(200)
    for o in offices:
        if _slugify(o.get("name", "")) == slug:
            return o
    return None


def _default_week_ending() -> str:
    today = datetime.now(APP_TZ).date()
    offset = (today.weekday() - 6) % 7
    return (today - timedelta(days=offset)).isoformat()


@router.get("/admin/offices/{office_id}/share-code")
async def get_share_code(office_id: str, request: Request):
    user = await get_current_user(request)
    if not user.get("is_super_admin"):
        raise HTTPException(status_code=403, detail="Super admin access required")
    office = await db.offices.find_one({"id": office_id}, {"_id": 0})
    if not office:
        raise HTTPException(status_code=404, detail="Office not found")
    slug = _slugify(office.get("name", ""))
    return {
        "office_id": office_id,
        "name": office.get("name"),
        "slug": slug,
        "share_code": office.get("bells_share_code") or None,
    }


SHARE_CODE_MIN_LENGTH = 16
SHARE_CODE_MAX_LENGTH = 80
# Wrong codes per caller IP + office: 10 per 15 minutes, then 429.
_SHARE_CODE_FAILURES = Limiter(10, 15 * 60)


def new_share_code() -> str:
    """A long random code (22 URL-safe characters, ~128 bits)."""
    return secrets.token_urlsafe(16)


@router.put("/admin/offices/{office_id}/share-code")
async def set_share_code(office_id: str, request: Request):
    """Turn the public Bells link on or off.

    Body: {"generate": true}  → the server makes a long random code (normal path)
          {"share_code": ""}  → clear it (public sharing off)
          {"share_code": "…"} → use a code the admin typed (16+ characters)
    """
    user = await get_current_user(request)
    if not user.get("is_super_admin"):
        raise HTTPException(status_code=403, detail="Super admin access required")
    if not await db.offices.find_one({"id": office_id}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Office not found")
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    if body.get("generate"):
        code = new_share_code()
    else:
        code = str(body.get("share_code") or "").strip()
        if not code:
            # Clear the code (disable public sharing)
            await db.offices.update_one({"id": office_id}, {"$unset": {"bells_share_code": ""}})
            return {"ok": True, "share_code": None}
        if len(code) < SHARE_CODE_MIN_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=f"Share code must be at least {SHARE_CODE_MIN_LENGTH} characters (or tap Generate)",
            )
        if len(code) > SHARE_CODE_MAX_LENGTH:
            raise HTTPException(status_code=400, detail="Share code is too long")
    await db.offices.update_one({"id": office_id}, {"$set": {"bells_share_code": code}})
    return {"ok": True, "share_code": code}


def _share_code_matches(supplied: str, expected: str) -> bool:
    return secrets.compare_digest(supplied.encode(), expected.encode())


async def _public_bells_payload(office_slug: str, week: Optional[str], code: Optional[str],
                                request: Optional[Request] = None):
    """Shared logic for /public/bells and /public/bells/csv. Returns (office, week_ending, entries, totals)."""
    office = await _find_office_by_slug(office_slug)
    if not office:
        raise HTTPException(status_code=404, detail="Office not found")
    expected_code = (office.get("bells_share_code") or "").strip()
    if not expected_code:
        raise HTTPException(status_code=403, detail="Public sharing is not enabled for this office. Ask the admin to set up a share code.")
    if len(expected_code) < SHARE_CODE_MIN_LENGTH:
        # A short code from before the 16-character rule is guessable: treat
        # sharing as off until an admin generates a new one.
        raise HTTPException(status_code=403, detail="This office's share link has expired. Ask the admin to generate a new share code.")
    throttle_key = f"{client_ip(request) if request is not None else 'unknown'}:{office.get('id')}"
    _SHARE_CODE_FAILURES.check(throttle_key)
    supplied = (code or "").strip()
    if not _share_code_matches(supplied, expected_code):
        _SHARE_CODE_FAILURES.hit(throttle_key)
        raise HTTPException(status_code=401, detail="Invalid share code")
    raw_week = (week or "").strip() or _default_week_ending()
    week_ending = _coerce_to_sunday(raw_week)
    if not week_ending:
        raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")

    office_id = office["id"]
    fees = await db.commission_fees.find_one({"office_id": office_id}, {"_id": 0}) or await db.commission_fees.find_one({}, {"_id": 0})

    # Prior week count per user for traffic light 4-week minimum
    prior_week_counts_pub: dict = {}
    async for r in db.bells_entries.aggregate([
        {"$match": {"office_id": office_id, "week_ending": {"$lt": week_ending}}},
        {"$group": {"_id": "$user_id", "count": {"$sum": 1}}},
    ]):
        if r.get("_id"):
            prior_week_counts_pub[r["_id"]] = r["count"]

    # Previous week LW lookup
    prev_week = _prev_sunday_iso(week_ending)
    prev_rows = {}
    prev_prev_rows = {}
    if prev_week:
        async for pe in db.bells_entries.find(
            {"office_id": office_id, "week_ending": prev_week},
            {"_id": 0, "user_id": 1, "user_name": 1, "days": 1},
        ):
            totals = compute_totals(pe, None)
            key = pe.get("user_id") or (pe.get("user_name") or "").strip().lower()
            prev_rows[key] = totals["total_sales"]
        prev_prev_week = _prev_sunday_iso(prev_week)
        if prev_prev_week:
            async for ppe in db.bells_entries.find(
                {"office_id": office_id, "week_ending": prev_prev_week},
                {"_id": 0, "user_id": 1, "user_name": 1, "days": 1},
            ):
                totals = compute_totals(ppe, None)
                key = ppe.get("user_id") or (ppe.get("user_name") or "").strip().lower()
                prev_prev_rows[key] = totals["total_sales"]

    # Entries for this week (only real entries, no auto-populated stubs)
    entries = await db.bells_entries.find(
        {"office_id": office_id, "week_ending": week_ending},
        {"_id": 0},
    ).to_list(500)

    # Filter out entries the admin has hidden for this specific week
    entries = [e for e in entries if not e.get("public_hidden")]

    # Admins stay off the public sheet unless they actually sold this week —
    # saves the office manually hiding them every Monday. Manual visibility
    # controls above still apply to everyone else.
    admin_ids: set = set()
    _admin_uids = [e.get("user_id") for e in entries if e.get("user_id")]
    if _admin_uids:
        from bson import ObjectId as _ObjId
        _oids = []
        for _uid in _admin_uids:
            try:
                _oids.append(_ObjId(_uid))
            except Exception:
                pass
        if _oids:
            async for _u in db.users.find(
                {"_id": {"$in": _oids}, "role": "admin"}, {"_id": 1}
            ):
                admin_ids.add(str(_u["_id"]))
    if admin_ids:
        # NOT a sales total — memberships are in here ON PURPOSE because this
        # is a "did this admin do anything at all this week" gate, and an
        # admin who only logged memberships should still show a row. It was
        # called _week_sales, which is how a membership-inflated figure gets
        # copied into somewhere that really does mean sales. Sales are
        # over30 + under30, never memberships.
        def _week_activity(e: dict) -> int:
            return sum(
                (d.get("over30") or 0) + (d.get("under30") or 0) + (d.get("memberships") or 0)
                for d in (e.get("days") or [])
            )
        entries = [
            e for e in entries
            if e.get("user_id") not in admin_ids or _week_activity(e) > 0
        ]

    # Enrich
    enriched = []
    sum_totals = {"total_over30": 0, "total_under30": 0, "total_memberships": 0, "total_sales": 0, "days_worked": 0, "earnings": 0.0}
    office_daily_totals = [0, 0, 0, 0, 0, 0, 0]
    in_days_total = 0
    in_days_with_sale = 0
    reps_active = 0
    reps_green = 0
    for e in entries:
        t = compute_totals(e, fees)
        e.update(t)
        key = e.get("user_id") or (e.get("user_name") or "").strip().lower()
        if e.get("last_week_total") is None:
            prev_val = prev_rows.get(key)
            if prev_val is not None:
                e["last_week_total"] = prev_val
                e["last_week_total_source"] = "auto"
        if e.get("last_week_total") is not None and not e.get("last_week_total_source"):
            e["last_week_total_source"] = "manual"
        e["prev_prev_week_total"] = prev_prev_rows.get(key)
        uid_pub = e.get("user_id")
        e["prior_weeks"] = prior_week_counts_pub.get(uid_pub, 0) if uid_pub else 0
        enriched.append(e)
        for k in ("total_over30", "total_under30", "total_memberships", "total_sales", "days_worked"):
            sum_totals[k] += t[k]
        sum_totals["earnings"] += t["earnings"]
        for i, v in enumerate(t.get("daily_totals") or []):
            if i < 7:
                office_daily_totals[i] += int(v or 0)
        # Scoring + Green tracking (same logic as the in-app payload)
        e_in_days = sum(1 for d in (e.get("days") or []) if _is_in_day(d))
        e_in_days_with_sale = sum(
            1 for d in (e.get("days") or [])
            if _is_in_day(d) and (int(_safe_num(d.get("over30")) + _safe_num(d.get("under30"))) > 0)
        )
        in_days_total += e_in_days
        in_days_with_sale += e_in_days_with_sale
        if e_in_days > 0:
            reps_active += 1
            if int(t.get("total_sales") or 0) >= GREEN_WEEK_SALES:
                reps_green += 1

    sum_totals["piece_average"] = round(sum_totals["total_sales"] / sum_totals["days_worked"], 2) if sum_totals["days_worked"] > 0 else 0.0
    sum_totals["average_earnings_per_day"] = round(sum_totals["earnings"] / sum_totals["days_worked"], 2) if sum_totals["days_worked"] > 0 else 0.0
    sum_totals["earnings"] = round(sum_totals["earnings"], 2)
    sum_totals["daily_totals"] = office_daily_totals
    # Public payload — match list_bells percentages
    sum_totals["pct_over30"] = (
        round((sum_totals["total_over30"] / sum_totals["total_sales"]) * 100)
        if sum_totals["total_sales"] > 0 else 0
    )
    sum_totals["pct_under30"] = (
        round((sum_totals["total_under30"] / sum_totals["total_sales"]) * 100)
        if sum_totals["total_sales"] > 0 else 0
    )
    sum_totals["pct_memberships"] = (
        round((sum_totals["total_memberships"] / sum_totals["total_sales"]) * 100)
        if sum_totals["total_sales"] > 0 else 0
    )
    sum_totals["scoring_pct"] = (
        round((in_days_with_sale / in_days_total) * 100)
        if in_days_total > 0 else 0
    )
    sum_totals["green_pct"] = (
        round((reps_green / reps_active) * 100)
        if reps_active > 0 else 0
    )
    sum_totals["reps_active"] = reps_active
    sum_totals["reps_green"] = reps_green

    # Build reports_to_map and a join_key (start_date / created_at) so the
    # public payload sorts identically to the in-app /api/bells endpoint.
    reports_to_map: dict = {}
    user_created_at: dict = {}
    role_map: dict = {}
    try:
        uids = [e["user_id"] for e in enriched if e.get("user_id")]
        if uids:
            async for u in db.users.find(
                {"_id": {"$in": [ObjectId(x) for x in uids]}},
                {"_id": 1, "role": 1, "reports_to": 1, "created_at": 1},
            ):
                uid = str(u["_id"])
                reports_to_map[uid] = u.get("reports_to")
                user_created_at[uid] = u.get("created_at")
                role_map[uid] = u.get("role")
                # Backfill role on the entry if missing
                for e in enriched:
                    if e.get("user_id") == uid and not e.get("role"):
                        e["role"] = u.get("role")

        new_hire_starts: dict = {}
        try:
            async for h in db.new_hires.find(
                {"office_id": office["id"]},
                {"trainee_user_id": 1, "start_date": 1},
            ):
                if h.get("trainee_user_id"):
                    new_hire_starts[str(h["trainee_user_id"])] = h.get("start_date")
        except Exception:
            pass

        def _join_key(uid: str):
            return new_hire_starts.get(uid) or user_created_at.get(uid) or ""

        # Team enrichment must happen BEFORE the section-aware sort so each
        # entry knows which section it belongs to.
        await _enrich_entries_with_teams(enriched)
        await _attach_absence_details(enriched, office_id, week_ending)
        _attach_team_subtree_sales(enriched, reports_to_map)
        enriched = _section_aware_sort(enriched, reports_to_map, _join_key, role_map)
    except Exception:
        # Fallback: enrich (so the UI still groups) and apply a flat alpha
        # sort if anything goes wrong.
        try:
            await _enrich_entries_with_teams(enriched)
            await _attach_absence_details(enriched, office_id, week_ending)
        except Exception:
            pass
        enriched.sort(key=lambda e: (0 if e.get("role") == "trainee" else 1, (e.get("user_name") or "").lower()))

    return office, week_ending, enriched, sum_totals


@router.get("/public/bells/{office_slug}")
async def public_bells(office_slug: str, request: Request):
    """Public read-only weekly snapshot. Requires `?code=...` matching the office share code.
    Accepts optional `?week=YYYY-MM-DD` (Sunday) to look up historical weeks.
    """
    code = request.query_params.get("code")
    week = request.query_params.get("week")
    office, week_ending, enriched, totals = await _public_bells_payload(office_slug, week, code, request)
    prev_week = _prev_sunday_iso(week_ending)

    # Aggregate teams for the "Teams" tab on the public page
    prev_rows_by_key: dict = {}
    if prev_week:
        async for pe in db.bells_entries.find(
            {"office_id": office["id"], "week_ending": prev_week},
            {"_id": 0, "user_id": 1, "user_name": 1, "days": 1},
        ):
            t = compute_totals(pe, None)
            k = pe.get("user_id") or (pe.get("user_name") or "").strip().lower()
            prev_rows_by_key[k] = t["total_sales"]
    # "Working Now" is only meaningful when viewing the CURRENT week. For
    # historical weeks the count must be 0 (passing -1 disables the bump in
    # _aggregate_teams_from_enriched). Use the app's clock (APP_TZ, UK time)
    # rather than the server's UTC — during BST the UTC date lags an hour
    # after midnight and would mis-attribute today's status.
    today = datetime.now(APP_TZ).date()
    today_dow = today.weekday()  # Mon=0..Sun=6
    current_week_end = (today + timedelta(days=(6 - today_dow) % 7)).isoformat()
    is_current_week = (week_ending == current_week_end)
    teams_agg = _aggregate_teams_from_enriched(
        enriched, prev_rows_by_key,
        today_dow if is_current_week else -1,
    )

    return {
        "office_name": office.get("name"),
        "office_slug": office_slug,
        "week_ending": week_ending,
        "previous_week_ending": prev_week,
        "entries": enriched,
        "office_totals": totals,
        "teams": teams_agg,
    }


@router.get("/public/bells/{office_slug}/csv")
async def public_bells_csv(office_slug: str, request: Request):
    """Public CSV export. Requires `?code=...` matching the office share code."""
    import io
    import csv as _csv
    from fastapi.responses import Response as FastResponse

    code = request.query_params.get("code")
    week = request.query_params.get("week")
    office, week_ending, enriched, _ = await _public_bells_payload(office_slug, week, code, request)

    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow([
        "Name", "Role",
        "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
        "Sign-ups", "£15+", "£12",
        "Days Worked", "Piece Avg", "BA fees (£)",
    ])
    for e in enriched:
        days = e.get("days") or []
        day_cells = []
        for i in range(7):
            d = days[i] if i < len(days) else {}
            status = (d or {}).get("status") or "off"
            tot = ((d or {}).get("over30") or 0) + ((d or {}).get("under30") or 0)
            if status == "off":
                day_cells.append("")
            elif status == "nc":
                day_cells.append("nc")
            elif status == "rt":
                day_cells.append(f"rt {tot}" if tot > 0 else "rt")
            else:
                day_cells.append(str(tot))
        w.writerow([
            e.get("user_name", ""),
            (e.get("role") or "").capitalize(),
            *day_cells,
            e.get("total_sales") or 0,
            e.get("total_over30") or 0,
            e.get("total_under30") or 0,
            e.get("days_worked") or 0,
            f"{(e.get('piece_average') or 0):.1f}",
            round(e.get("earnings") or 0),
        ])

    filename = f"bells-{office_slug}-{week_ending}.csv"
    return FastResponse(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
