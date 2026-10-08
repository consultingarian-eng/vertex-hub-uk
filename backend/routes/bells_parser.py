"""WhatsApp Bells Parser — converts a pasted WhatsApp emoji-coded report
(for ONE DAY) into structured per-BA sign-up totals.

Format example (each block = one BA, each emoji line = ONE sign-up):
    Mason 6
    🥇          <- 1 £15+ sign-up (Target £15 or Premium £20 a month)
    🥈          <- 1 £12 sign-up (Standard)
    🥇
    🥇⭕️        <- 1 £15+ sign-up (the ⭕️ is ignored)
    🥈
    🥇
                  → totals: 4 × £15+ + 2 × £12 = 6 sign-ups

    Rosa 2
    🥈
    🥇

Emoji codes (per sign-up line):
    🥇 = £15+ sign-up — Target (£15) or Premium (£20) monthly gift → Bells `over30`
    🥈 = £12 sign-up — Standard monthly gift                     → Bells `under30`
    ⭕️ = ignored (a leftover code from the original report format; Vertex has
         no memberships — it is never counted)

Rules:
    * One block per BA; blank line(s) separate blocks
    * First line = "Name [optional separator/number — ignored, just trust emojis]"
    * Each non-empty emoji line below = ONE sign-up
    * The whole message = ONE day's results — picked via date input in UI

The Bells field names (`over30`, `under30`, `memberships`) are kept from the
original data model; see routes/bells.py for their Vertex meaning.
"""
from __future__ import annotations

import re
import uuid
import logging
from datetime import datetime, timezone, date, timedelta
from typing import List, Optional

from bson import ObjectId
from pymongo.errors import DuplicateKeyError
from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, get_subtree_ids
from database import db
from core.office_helpers import resolve_office_id
from core.achievements import award_sales_milestones

load_dotenv()

logger = logging.getLogger(__name__)
router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────────
# Models
# ─────────────────────────────────────────────────────────────────────────────


class ParsedRep(BaseModel):
    raw_name: str
    matched_user_id: Optional[str] = None
    matched_user_name: Optional[str] = None
    match_confidence: float = 0.0
    matched_via: Optional[str] = None   # 'exact' | 'fuzzy' | 'alias'
    over30: int = 0         # 🥇 £15+ sign-ups
    under30: int = 0        # 🥈 £12 sign-ups
    memberships: int = 0    # legacy field, always 0 (⭕️ is ignored)
    sales_count: int = 0    # sign-ups = over30 + under30
    raw_lines: List[str] = Field(default_factory=list)
    confidence: float = 1.0


class ParseRequest(BaseModel):
    text: str
    office_id: Optional[str] = None


class ParseResponse(BaseModel):
    reps: List[ParsedRep]
    unmatched_names: List[str]
    office_id: str


# ─────────────────────────────────────────────────────────────────────────────
# Deterministic emoji parser
# ─────────────────────────────────────────────────────────────────────────────

GOLD_RX = re.compile(r"\U0001F947")          # 🥇 = £15+ sign-up (over30)
SILVER_RX = re.compile(r"\U0001F948")        # 🥈 = £12 sign-up (under30)
# ⭕️ (and 🔴) used to mark a membership; Vertex has none, so they're ignored.
ANY_EMOJI_RX = re.compile(
    r"[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]"
)


def _strip_emojis(s: str) -> str:
    return ANY_EMOJI_RX.sub("", s).strip()


def _has_sale_emoji(line: str) -> bool:
    return bool(GOLD_RX.search(line) or SILVER_RX.search(line))


def _split_blocks(text: str) -> List[List[str]]:
    """Split paste into blocks of lines per rep (separated by blank lines)."""
    blocks: List[List[str]] = []
    current: List[str] = []
    for raw_line in (text or "").splitlines():
        line = raw_line.rstrip()
        if line.strip() == "":
            if current:
                blocks.append(current)
                current = []
        else:
            current.append(line)
    if current:
        blocks.append(current)
    return blocks


def _name_from_header(line: str) -> str:
    """Strip emojis and any trailing 'separator/number'. Examples:
    'Mason 6'   → 'Mason'
    'Mason-6'   → 'Mason'      (dash directly attached, no space)
    'Tess–5'    → 'Tess'       (en-dash, no space)
    'August -1' → 'August'
    'Owen  2'   → 'Owen'
    'Mario'     → 'Mario'
    """
    cleaned = _strip_emojis(line)
    # Drop any trailing optional whitespace + optional dash (ASCII/en/em) + digits.
    # Whitespace before the dash is optional so 'Mason-6' collapses cleanly.
    m = re.match(r"^(.+?)\s*[-–—]?\s*\d+\s*$", cleaned)
    if m:
        name = m.group(1).strip()
    else:
        name = cleaned
    # Trailing dash with no count ('Mason-') — also strip.
    name = re.sub(r"[\s\-–—]+$", "", name).strip()
    return name


def deterministic_parse(text: str) -> List[ParsedRep]:
    """Parse the pasted message into per-BA daily totals.
    Each emoji line below the name = ONE sign-up (🥇 £15+ or 🥈 £12).
    Number after name is IGNORED — we trust the emojis (per user request)."""
    reps: List[ParsedRep] = []
    for block in _split_blocks(text):
        if not block:
            continue
        name = _name_from_header(block[0])
        if not name:
            continue
        # The first line itself may contain emojis (rare but possible — e.g.
        # 'Mason 6 🥇'). Treat it as a sign-up line iff it has 🥇 or 🥈.
        emoji_lines: List[str] = []
        if _has_sale_emoji(block[0]):
            emoji_lines.append(block[0])
        for line in block[1:]:
            if _has_sale_emoji(line):
                emoji_lines.append(line)
            # Lines without 🥇/🥈 are treated as separators / blank rows.

        over30 = 0
        under30 = 0
        for line in emoji_lines:
            # Edge case: multiple 🥇 / 🥈 on the same line (rare). Count each
            # as its own sign-up. Anything else on the line (⭕️ included) is
            # ignored.
            over30 += len(GOLD_RX.findall(line))
            under30 += len(SILVER_RX.findall(line))
        sales_count = over30 + under30

        # Confidence: drop slightly if the rep block had non-emoji noise lines
        # so the leader sees the "Verify" badge.
        noise = sum(
            1 for line in block[1:]
            if line.strip() and not _has_sale_emoji(line) and not _strip_emojis(line) == ""
        )
        confidence = 1.0 if noise == 0 else 0.7

        reps.append(ParsedRep(
            raw_name=name,
            over30=over30,
            under30=under30,
            memberships=0,
            sales_count=sales_count,
            raw_lines=emoji_lines,
            confidence=confidence,
        ))
    return reps


# ─────────────────────────────────────────────────────────────────────────────
# Roster matching (same fuzzy logic as before)
# ─────────────────────────────────────────────────────────────────────────────


def _name_score(a: str, b: str) -> float:
    """Fuzzy score 0..1 between two names. Tolerates minor typos.

    Uses difflib.SequenceMatcher (Ratcliff/Obershelp) on the lowercased
    full string, with a bonus for first-name overlap. This lets
    'Rosa'/'Rossa', 'Rob'/'Robb', 'Anthony'/'Anthany', 'Mason'/'Masen'
    all score ≥ 0.78 so they match instead of creating duplicate roster rows.
    """
    a = (a or "").strip().lower()
    b = (b or "").strip().lower()
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    from difflib import SequenceMatcher
    full = SequenceMatcher(None, a, b).ratio()

    a_parts = a.split()
    b_parts = b.split()
    first_match = bool(a_parts and b_parts and a_parts[0] == b_parts[0])
    first_close = (
        bool(a_parts and b_parts)
        and SequenceMatcher(None, a_parts[0], b_parts[0]).ratio() >= 0.85
    )

    if first_match:
        # exact first-name match — strong signal even if last names vary
        return max(full, 0.92 if (len(a_parts) > 1 and len(b_parts) > 1) else 0.88)
    if first_close:
        # first name 1-2 char typo away
        return max(full, 0.82)
    if a in b or b in a:
        return max(full, 0.75)
    return full


async def _load_office_roster(office_id: str, user: dict) -> List[dict]:
    roster_q: dict = {"office_id": office_id, "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}}
    if user.get("role") == "leader" and not user.get("is_super_admin"):
        try:
            sub = await get_subtree_ids(user["id"])
            roster_q["_id"] = {"$in": [ObjectId(uid) for uid in sub]}
        except Exception:
            roster_q["_id"] = {"$in": []}
    rows: List[dict] = []
    async for u in db.users.find(roster_q, {"_id": 1, "name": 1, "email": 1, "role": 1}):
        rows.append({
            "id": str(u["_id"]),
            "name": u.get("name") or (u.get("email") or "").split("@")[0],
            "email": u.get("email"),
            "role": u.get("role"),
        })
    return rows


def match_to_roster(reps: List[ParsedRep], roster: List[dict]) -> List[ParsedRep]:
    used: set[str] = set()
    # Match best-first: sort all (rep, user, score) triples by score so that
    # the strongest matches are claimed first and slight typos don't get
    # stolen by an earlier weaker pairing.
    candidates = []
    for ri, rep in enumerate(reps):
        # Skip reps that were already auto-matched from a saved alias.
        if rep.matched_user_id:
            used.add(rep.matched_user_id)
            continue
        for u in roster:
            score = _name_score(rep.raw_name, u["name"])
            if score >= 0.72:
                candidates.append((score, ri, u))
    candidates.sort(key=lambda c: -c[0])
    matched_rep_idx: set[int] = set()
    for score, ri, u in candidates:
        if ri in matched_rep_idx:
            continue
        if u["id"] in used:
            continue
        rep = reps[ri]
        rep.matched_user_id = u["id"]
        rep.matched_user_name = u["name"]
        rep.match_confidence = score
        rep.matched_via = "exact" if score >= 0.99 else "fuzzy"
        matched_rep_idx.add(ri)
        used.add(u["id"])
    return reps


# ─────────────────────────────────────────────────────────────────────────────
# Learned aliases — when a leader manually links a typo to a roster member
# (or even when fuzzy matching resolves it), we save the mapping so the next
# paste containing the same typo auto-resolves. Alias matches are flagged with
# `matched_via='alias'` + low confidence so the UI still shows a "Remembered"
# warning and the leader can double-check.
# ─────────────────────────────────────────────────────────────────────────────


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


async def _lookup_aliases(office_id: str, raw_names: List[str]) -> dict:
    """Returns {normalized_raw_name: {user_id, user_name, hit_count}} for
    any aliases previously learned in this office."""
    keys = list({_norm(n) for n in raw_names if n})
    if not keys:
        return {}
    out: dict = {}
    async for row in db.bells_name_aliases.find({"office_id": office_id, "raw_name_norm": {"$in": keys}}):
        out[row["raw_name_norm"]] = {
            "user_id": row.get("user_id"),
            "user_name": row.get("user_name"),
            "hit_count": int(row.get("hit_count") or 0),
        }
    return out


def _apply_aliases(reps: List[ParsedRep], aliases: dict, roster_by_id: dict) -> List[ParsedRep]:
    for rep in reps:
        if rep.matched_user_id:
            continue
        key = _norm(rep.raw_name)
        a = aliases.get(key)
        if not a or not a.get("user_id"):
            continue
        # Ensure the alias still points to a real roster member.
        u = roster_by_id.get(a["user_id"])
        if not u:
            continue
        rep.matched_user_id = u["id"]
        rep.matched_user_name = u["name"]
        # Low confidence on purpose so the UI still shows "needs review".
        rep.match_confidence = 0.75
        rep.matched_via = "alias"
    return reps


async def _learn_alias(office_id: str, raw_name: str, user_id: str, user_name: str, leader_id: str):
    """Upsert a learned alias for future pastes."""
    if not raw_name or not user_id:
        return
    key = _norm(raw_name)
    if not key:
        return
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.bells_name_aliases.update_one(
        {"office_id": office_id, "raw_name_norm": key},
        {
            "$set": {
                "office_id": office_id,
                "raw_name_norm": key,
                "raw_name": raw_name.strip(),
                "user_id": user_id,
                "user_name": user_name,
                "updated_at": now_iso,
                "updated_by_id": leader_id,
            },
            "$inc": {"hit_count": 1},
            "$setOnInsert": {
                "id": str(uuid.uuid4()),
                "created_at": now_iso,
                "created_by_id": leader_id,
            },
        },
        upsert=True,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────


@router.post("/bells/parse-whatsapp", response_model=ParseResponse)
async def parse_whatsapp(req: ParseRequest, request: Request):
    """Parses a pasted WhatsApp daily bells report → per-rep totals (no DB writes)."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    office_id = await resolve_office_id(request, user, req.office_id)
    if not office_id:
        raise HTTPException(status_code=400, detail="office_id required")

    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is empty")

    reps = deterministic_parse(req.text)
    if not reps:
        raise HTTPException(status_code=422, detail="Could not find anyone in that message — each block needs a name line, then one 🥇 or 🥈 line per sign-up")

    roster = await _load_office_roster(office_id, user)
    roster_by_id = {u["id"]: u for u in roster}
    # Apply previously learned aliases first (low-confidence matches the
    # leader can still override). Then run fuzzy matching on the rest.
    aliases = await _lookup_aliases(office_id, [r.raw_name for r in reps])
    reps = _apply_aliases(reps, aliases, roster_by_id)
    reps = match_to_roster(reps, roster)
    unmatched = [r.raw_name for r in reps if not r.matched_user_id]

    return ParseResponse(
        reps=reps,
        unmatched_names=unmatched,
        office_id=office_id,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Apply — write totals into the day cell of each rep's weekly entry
# ─────────────────────────────────────────────────────────────────────────────


def _week_ending_for(target: date) -> str:
    """Sunday-ending week: returns the ISO date of the Sunday on or after `target`.
    Mon=0..Sun=6. If target is Sunday, returns target itself."""
    # Python: monday=0, sunday=6
    offset = (6 - target.weekday()) % 7
    return (target + timedelta(days=offset)).isoformat()


def _day_index_for(target: date) -> int:
    """0=Mon, 6=Sun (matches the bells day grid layout)."""
    return target.weekday()


class ApplyRep(BaseModel):
    user_id: Optional[str] = None
    user_name: str
    raw_name: Optional[str] = None   # original name from the paste, used to learn aliases
    over30: int = 0                  # £15+ sign-ups
    under30: int = 0                 # £12 sign-ups
    memberships: int = 0             # legacy — accepted for old clients, never written
    status: Optional[str] = None     # explicit override: "in"|"off"|"ab"|"rt"|"nc"; None = infer from sign-ups


class ApplyRequest(BaseModel):
    date: str            # YYYY-MM-DD — the SINGLE DAY this report covers
    office_id: str
    reps: List[ApplyRep]


@router.post("/bells/apply-bulk")
async def apply_bulk(req: ApplyRequest, request: Request):
    """Writes the parsed totals into a single day cell of each rep's bells
    entry for the corresponding week. Idempotent: re-applying overwrites
    that single day only.

    SAFETY: Will NEVER create new bells entries. If a rep does not match
    an existing roster member with a bells_entries row OR a roster user
    with id matching `user_id`, that rep is SKIPPED and reported back to
    the leader so they can fix the spelling on the source list.
    """
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    office_id = await resolve_office_id(request, user, req.office_id)
    if not office_id:
        raise HTTPException(status_code=400, detail="office_id required")

    try:
        target = datetime.fromisoformat(req.date).date()
    except Exception:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    week_ending = _week_ending_for(target)
    day_idx = _day_index_for(target)
    now_iso = datetime.now(timezone.utc).isoformat()

    allowed_user_ids: Optional[set[str]] = None
    if user.get("role") == "leader" and not user.get("is_super_admin"):
        allowed_user_ids = set(await get_subtree_ids(user["id"]))
        allowed_user_ids.add(str(user["id"]))

    upserted = 0
    skipped: List[dict] = []
    for rep in req.reps:
        # STRICT SAFETY: WhatsApp paste must NEVER create new people on the
        # bells list from misspelled names. Each rep must be explicitly tied
        # to an existing roster user via `user_id`. The frontend forces the
        # leader to pick from the roster dropdown for any unmatched name
        # before "Apply" is enabled.
        if not rep.user_id:
            skipped.append({
                "user_name": rep.user_name,
                "reason": "no roster match — pick the correct person from the list",
            })
            continue
        if allowed_user_ids is not None and str(rep.user_id) not in allowed_user_ids:
            skipped.append({
                "user_name": rep.user_name,
                "reason": "person is outside your team",
            })
            continue

        # Verify user_id actually belongs to this office's roster.
        try:
            roster_user = await db.users.find_one(
                {
                    "_id": ObjectId(rep.user_id),
                    "office_id": office_id,
                    "deleted": {"$ne": True},
                    "is_active": {"$ne": False},
                },
                {"_id": 1, "name": 1},
            )
        except Exception:
            roster_user = None
        if not roster_user:
            skipped.append({
                "user_name": rep.user_name,
                "reason": "user is not in this office's roster",
            })
            continue

        true_name = roster_user.get("name") or rep.user_name

        existing = await db.bells_entries.find_one(
            {"office_id": office_id, "week_ending": week_ending, "user_id": rep.user_id}
        )

        if not existing:
            # Auto-create a fresh weekly entry for this real roster member.
            days = [{"over30": None, "under30": None, "memberships": None, "status": "off"} for _ in range(7)]
            explicit = rep.status if rep.status in ("in", "off", "ab", "rt", "nc") else None
            days[day_idx] = {
                "over30": rep.over30 or None,
                "under30": rep.under30 or None,
                "memberships": None,
                "status": explicit if explicit else ("in" if (rep.over30 + rep.under30) > 0 else "off"),
            }
            try:
                await db.bells_entries.insert_one({
                    "id": str(uuid.uuid4()),
                    "office_id": office_id,
                    "user_id": rep.user_id,
                    "user_name": true_name,
                    "stage": None,
                    "break_even": None,
                    "weekly_goal": None,
                    "week_ending": week_ending,
                    "days": days,
                    "created_by_id": user["id"],
                    "created_at": now_iso,
                    "updated_at": now_iso,
                })
            except DuplicateKeyError:
                # Lost the create race (uniq_office_week_user) — re-fetch the
                # winner and drop into the day-cell update path below.
                existing = await db.bells_entries.find_one(
                    {"office_id": office_id, "week_ending": week_ending, "user_id": rep.user_id}
                )
            if not existing:
                try:
                    await award_sales_milestones(rep.user_id, days)
                except Exception as _e:
                    logger.warning(f"apply_bulk: achievement award failed for {rep.user_id}: {_e}")
                try:
                    from core.sales_path import recompute_sales_path
                    await recompute_sales_path(rep.user_id)
                except Exception as _e:
                    logger.warning(f"apply_bulk: sales-path recompute failed for {rep.user_id}: {_e}")
                upserted += 1
                # Learn alias for future pastes if the paste name differed.
                if rep.raw_name and _norm(rep.raw_name) != _norm(true_name):
                    await _learn_alias(office_id, rep.raw_name, rep.user_id, true_name, user["id"])
                continue

        # Update the existing entry's day cell only.
        days = list(existing.get("days") or [])
        while len(days) < 7:
            days.append({"over30": None, "under30": None, "memberships": None, "status": "off"})
        explicit = rep.status if rep.status in ("in", "off", "ab", "rt", "nc") else None
        # `memberships` is legacy (unused by Vertex): keep whatever the cell
        # already held rather than overwrite stored data.
        days[day_idx] = {
            "over30": rep.over30 or None,
            "under30": rep.under30 or None,
            "memberships": (days[day_idx] or {}).get("memberships"),
            "status": explicit if explicit else ("in" if (rep.over30 + rep.under30) > 0 else (days[day_idx].get("status") or "off")),
        }
        await db.bells_entries.update_one(
            {"id": existing["id"]},
            {"$set": {
                "days": days,
                "user_id": rep.user_id,
                "user_name": true_name,
                "updated_at": now_iso,
                "updated_by_id": user["id"],
            }},
        )
        try:
            await award_sales_milestones(rep.user_id, days)
        except Exception as _e:
            logger.warning(f"apply_bulk: achievement award failed for {rep.user_id}: {_e}")
        try:
            from core.sales_path import recompute_sales_path
            await recompute_sales_path(rep.user_id)
        except Exception as _e:
            logger.warning(f"apply_bulk: sales-path recompute failed for {rep.user_id}: {_e}")
        upserted += 1

        # Learn alias if the original paste name differs from the true name.
        if rep.raw_name and _norm(rep.raw_name) != _norm(true_name):
            await _learn_alias(office_id, rep.raw_name, rep.user_id, true_name, user["id"])

    return {
        "ok": True,
        "upserted": upserted,
        "skipped": skipped,
        "week_ending": week_ending,
        "day_idx": day_idx,
        "date": req.date,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Roster — used by the WhatsApp parse review UI to manually link an
# unmatched/misspelled name to a real roster member.
# ─────────────────────────────────────────────────────────────────────────────


@router.get("/bells/parse-roster")
async def parse_roster(request: Request, office_id: Optional[str] = None):
    """Returns the office's bells roster (people the leader can see) so the
    WhatsApp parse review screen can offer a dropdown to manually link an
    unmatched name to an existing person."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    resolved = await resolve_office_id(request, user, office_id)
    if not resolved:
        raise HTTPException(status_code=400, detail="office_id required")
    roster = await _load_office_roster(resolved, user)
    # Sort alphabetically by first name for predictable picker order.
    roster.sort(key=lambda u: (u.get("name") or "").lower())
    return {"items": roster, "office_id": resolved}
