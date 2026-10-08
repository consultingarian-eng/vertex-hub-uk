"""Vertex's office week: the Mon–Fri timetable, its lanes, and who sits in which.

The office timetable runs in four lanes, the columns of the Owner's schedule
sheet: Stage 4+, Leaders (Stage 3 / 3+ Coaches), Stage 2 and Stage 1. Most
days show Stage 1 and Stage 2 together as "Stage 1/2"; Wednesday (Shadow Day)
splits them. A block lists the lanes it covers in `groups`; a block without
`groups` (older data) gets its lanes from its audience.

Office blocks are the Owner's template: only an admin edits them. Everyone
else adds personal events and tasks on top (audience 'personal').
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

GROUPS = ("s4", "ld", "s2", "s1")
GROUP_LABELS = {"s4": "Stage 4+", "ld": "Leaders", "s2": "Stage 2", "s1": "Stage 1"}
ALL = list(GROUPS)
S4, LD, S12 = ["s4"], ["ld"], ["s2", "s1"]

TEMPLATE_ID = "vertex-week-v1"

# Colours follow the Owner's sheet, lifted a touch so the white titles stay
# readable on the green app background.
GOLD = "#9a7600"      # owner / FR calls, core catch-up
BROWN = "#4a2c10"     # team meetings
PRIME = "#4a2236"     # Prime-Time
BLUE = "#1d4468"      # impact sessions, coaching calls
SKY = "#2a6197"       # Stage 1 / Stage 2 sessions
NAVY = "#13284f"      # Sectors
OLIVE = "#4f420a"     # Morning Meeting
FIELD = "#2c5a26"     # Field
CYAN = "#22d3e6"      # Appointments
BAM = "#3d2f63"       # BAM

FIELD_END = "20:30"


def _b(day, start, end, title, groups, color):
    return {"day_of_week": day, "start_time": start, "end_time": end,
            "title": title, "groups": list(groups), "color": color}


VERTEX_WEEK: list[dict] = [
    # Monday
    _b(0, "08:30", "09:15", "Core catch-up", S4, GOLD),
    _b(0, "09:15", "09:45", "Team meetings", S4, BROWN),
    _b(0, "09:45", "10:15", "Prime-Time", LD, PRIME),
    _b(0, "10:15", "11:15", "FR Goals + Sales Impact", ALL, BLUE),
    _b(0, "11:15", "11:45", "Sectors", S4, NAVY),
    _b(0, "11:15", "11:45", "Prime-Time", LD + S12, PRIME),
    _b(0, "11:45", "12:30", "Morning Meeting", ALL, OLIVE),
    _b(0, "12:30", FIELD_END, "Field", ALL, FIELD),
    # Tuesday: Day Trip
    _b(1, "08:45", "09:30", "Owners call", S4, GOLD),
    _b(1, "09:30", "10:00", "Appointments", S4, CYAN),
    _b(1, "10:00", "10:30", "Podcast Impact", S4 + LD, BLUE),
    _b(1, "10:30", "11:00", "Sectors", S4 + LD, NAVY),
    _b(1, "10:30", "11:15", "Prime-Time", S12, PRIME),
    _b(1, "11:15", FIELD_END, "Field", ALL, FIELD),
    # Wednesday: Shadow Day (Stage 2 and Stage 1 split)
    _b(2, "08:30", "09:00", "FR CALL", S4, GOLD),
    _b(2, "10:00", "10:15", "N/S Test", ["s1"], SKY),
    _b(2, "10:15", "11:00", "Coaching Leaders Meeting", S4 + LD, BLUE),
    _b(2, "10:15", "11:00", "Stage 2's Impact", ["s2"], SKY),
    _b(2, "10:15", "11:00", "S/D EXPECTATIONS", ["s1"], BLUE),
    _b(2, "11:00", "11:30", "Sectors", S4 + LD, NAVY),
    _b(2, "11:00", "11:45", "Prime-Time", S12, PRIME),
    _b(2, "11:45", "12:30", "Morning Meeting", ALL, OLIVE),
    _b(2, "12:30", FIELD_END, "Field", ALL, FIELD),
    # Thursday: Day Trip
    _b(3, "08:30", "09:00", "SRJ OWNERS CALL", S4, GOLD),
    _b(3, "09:30", "10:00", "Appointments", S4, CYAN),
    _b(3, "09:30", "10:15", "JMO 3+ Coaching Leaders call", LD, BLUE),
    _b(3, "10:30", "11:00", "Sectors", S4 + LD, NAVY),
    _b(3, "10:30", "11:15", "Prime-Time", S12, PRIME),
    _b(3, "11:15", FIELD_END, "Field", ALL, FIELD),
    # Friday: 2nd Day Badge
    _b(4, "08:30", "09:00", "FEO CALL", S4, GOLD),
    _b(4, "09:00", "09:45", "SALES COACHING ACADEMY", LD, BLUE),
    _b(4, "09:30", "10:00", "Appointments", S4, CYAN),
    _b(4, "10:00", "10:30", "Prime-Time", LD, PRIME),
    _b(4, "10:00", "10:45", "BAM", S12, BAM),
    _b(4, "10:30", "11:00", "Sectors", S4 + LD, NAVY),
    _b(4, "11:00", "12:15", "BAM", ALL, BAM),
    _b(4, "12:15", FIELD_END, "Field", ALL, FIELD),
]

# Shown beside the day name ("Tuesday · Day Trip"). Admin-editable per office.
VERTEX_DAY_LABELS = {"1": "Day Trip", "2": "Shadow Day", "3": "Day Trip", "4": "2nd Day Badge"}

# Titles of the schedule the office had before the Owner's timetable. An office
# whose Mon–Fri blocks are all still one of these gets the new week once.
_OLD_TITLES = {"PRIME TIME", "PRIMETIME", "PRIME-TIME", "BREAK", "PITCHING", "FIELD",
               "DAY TRIP: HEAD OUT TO FIELD AT 11:30"}


def stage_num(stage) -> float | None:
    """'stage_3_plus' → 3.5, 'stage_4' → 4, 3 → 3, None → None."""
    if stage is None or stage == "":
        return None
    if isinstance(stage, (int, float)):
        return float(stage)
    s = str(stage).lower().replace("stage_", "").replace("stage", "").strip()
    m = re.match(r"(\d+)", s)
    if not m:
        return None
    return int(m.group(1)) + (0.5 if s.endswith("plus") else 0.0)


def user_group(role: str | None, stage=None) -> str:
    """The lane a person sits in on the office timetable."""
    role = (role or "").lower()
    n = stage_num(stage)
    if role == "admin" or (n is not None and n >= 4):
        return "s4"
    if role == "leader" or (n is not None and n >= 3):
        return "ld"
    if n is not None and n >= 2:
        return "s2"
    return "s1"


def clean_groups(raw) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [g for g in GROUPS if g in {str(x).strip().lower() for x in raw}]


def block_groups(block: dict) -> list[str]:
    """Lanes a block covers: its own `groups`, else derived from audience."""
    g = clean_groups(block.get("groups"))
    if g:
        return g
    aud = (block.get("audience") or "all").lower()
    if aud == "personal":
        return []
    if aud in ("leaders", "core_leaders"):
        return ["s4", "ld"]
    if aud == "trainees":
        return ["s2", "s1"]
    return list(GROUPS)


def template_docs(office_id: str, now_iso: str | None = None) -> list[dict]:
    now_iso = now_iso or datetime.now(timezone.utc).isoformat()
    return [{
        "id": str(uuid.uuid4()), "office_id": office_id,
        "audience": "all", "core_leader_ids": [], "owner_id": None,
        "presenter": None, "topic": None, "details": None,
        "reminder_minutes": 5, "date": None, "kind": "event",
        "created_at": now_iso, "updated_at": now_iso, "seeded": True,
        "template": TEMPLATE_ID, **tpl,
    } for tpl in VERTEX_WEEK]


async def upgrade_office_schedules(db) -> dict:
    """Once per office: swap the old imported Mon–Fri schedule for the Owner's
    timetable. Skips (and never retries) an office whose Mon–Fri blocks an
    admin has already changed. Personal blocks and other days are untouched."""
    done = skipped = 0
    async for office in db.offices.find({"schedule_template": {"$exists": False}}, {"_id": 0, "id": 1}):
        oid = office.get("id")
        if not oid:
            continue
        office_q = {"office_id": oid, "audience": {"$ne": "personal"}, "day_of_week": {"$in": [0, 1, 2, 3, 4]}}
        blocks = await db.schedule_blocks.find(office_q, {"_id": 0, "title": 1}).to_list(1000)
        if not blocks:
            # Nothing there yet: the first read seeds the new week.
            continue
        if all((b.get("title") or "").strip().upper() in _OLD_TITLES for b in blocks):
            await db.schedule_blocks.delete_many(office_q)
            await db.schedule_blocks.insert_many(template_docs(oid))
            await db.offices.update_one({"id": oid}, {"$set": {
                "schedule_template": TEMPLATE_ID, "schedule_day_labels": VERTEX_DAY_LABELS}})
            done += 1
        else:
            await db.offices.update_one({"id": oid}, {"$set": {"schedule_template": "kept"}})
            skipped += 1
    if done or skipped:
        logger.info(f"schedule_template: upgraded {done} office(s), kept {skipped} edited")
    return {"upgraded": done, "kept": skipped}
