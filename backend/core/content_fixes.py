"""Startup content fixes — matched-text healing of live per-office training
content, plus a small data backfill. Wired into server.py's startup event;
safe to run on every boot:

  • Training-module + training-manual text fixes only touch a live doc whose
    stored text still EXACTLY equals the old seed/enrichment text. Docs an
    admin has edited are counted as skipped and logged — never clobbered.
    (Fixing the seed files alone does nothing for live offices: content is
    seeded per office and admins can edit it, so we heal in place.)
  • Live modules seeded under the orphan enrichment key
    "Example Setting How/Why" (which matched no real seed topic) are deleted
    when their content is still the orphan text.
  • delivery_checklist rows created before office stamping get office_id
    backfilled via the assessment → new_hire join.

Returns {"fixed": n, "skipped_edited": n} plus per-step counters.
"""
import logging

from core.module_content import STAGE_2_CONTENT
from seed_data import TRAINING_MANUAL

logger = logging.getLogger(__name__)


# ── Old text, verbatim as previously seeded ────────────────────────────────
# These strings no longer exist anywhere else in the codebase (they were the
# pre-2026-08-audit enrichment entries in core/module_content.py). They are
# kept here ONLY so live docs can be matched exactly before being replaced.

_OLD_GRASP = {
    "trainee_content": "GRASP is the framework that keeps your sales conversations on rails. By identifying the customer's Goals, Reality, Options, Solution, and Process you uncover what they actually need and tailor your offer to it. It's the difference between pitching at people and selling with them. Used well, GRASP makes closes feel inevitable rather than forced.",
    "what_good_looks_like": [
        "Names each letter of GRASP and what it stands for",
        "Asks GRASP questions naturally during a real conversation",
        "Tailors solutions to the customer's actual reality",
        "Avoids jumping straight to the pitch before listening",
        "Reviews own calls against the GRASP structure",
    ],
    "leader_coaching_notes": [
        "Walk through GRASP letter-by-letter with concrete examples",
        "Roleplay customer interactions and stop at each phase to coach",
        "Listen to call recordings and grade against the GRASP framework",
        "Push them to ask better questions, not pitch faster",
    ],
}

# The orphan enrichment key removed from module_content.py — never matched a
# real seed topic, but a module row may exist with it from an older seed.
ORPHAN_MODULE_TOPIC = "Example Setting How/Why"
_ORPHAN_TRAINEE_CONTENT = "People don't follow what you say — they follow what you do. You'll learn why modeling the right behavior, work ethic, and attitude is the most powerful coaching tool you have. When trainees see you knock when it's raining, stay late on a tough day, or stay positive after a flat sit, they internalize standards faster than any speech could teach."

_MODULE_CONTENT_FIELDS = ("trainee_content", "what_good_looks_like", "leader_coaching_notes")


def module_text_fixes() -> list:
    """(stage, topic, old_fields, new_fields) specs for live training_modules.

    GRASP: an older enrichment taught a mangled GROW ("Goals, Reality,
    Options, Solution, Process"); unedited live docs still carrying that text
    are healed to the current GRASP content from core/module_content.py.
    """
    return [{"stage": 2, "topic": "GRASP", "old": _OLD_GRASP,
             "new": {k: STAGE_2_CONTENT["GRASP"][k] for k in _MODULE_CONTENT_FIELDS}}]


# ── Training-manual text fixes (matched by day + topic, not sequence, so a
#    reordered day still heals) ─────────────────────────────────────────────

def manual_text_fixes() -> list:
    """(day_number, topic, old_fields, new_fields) specs for training_manual.

    Old numbers contradicted DAY_TARGETS (targets are canonical):
      D3 'Daily Funnel Targets' / 'Field Activity Minimum' said 7(-8)
      presentations vs target_presentations=8; D7 'Daily KPI Standard' and
      D8 'Replicate the Day' said 40+ pitches / 3+ deals vs 45 intros /
      14 presentations / 4 sales.
    New text is pulled from the (already-corrected) seed so there is exactly
    one source of truth for the corrected wording.
    """
    olds = [
        (3, "Daily Funnel Targets", {
            "what_good_looks_like": "Show the full-trained-day funnel — 90 doors × 3 laps, 45 spoken to, 15 pitches, 12 closes, 10 on phone, 4-8 signups — then scale it to today: 25 spoken to and 7-8 presentations of their own. Check the count at lunch, not just end of day.",
            "expected_outcome": "You know what a full day looks like — and your Day-3 slice of it: 25 conversations, 7-8 presentations, tracked by lunch.",
        }),
        (3, "Field Activity Minimum", {
            "what_good_looks_like": "Hold the line on today's minimum: 25 spoken-to and 7 presentations out of their own mouth. If they're short at 3pm, tighten the laps and tell them why — the standard is the standard from day one.",
            "expected_outcome": "You hit 25 conversations and 7 presentations today — or you know exactly how short you were and what changes tomorrow.",
        }),
        (7, "Daily KPI Standard", {
            "what_good_looks_like": "Hold the solo-rep bar: 40+ pitches, 3+ deals, 1+ membership, 80%+ valid-sale rate. Have them check the count at lunch and at 3pm — a gap you catch at noon is coachable; a gap you find at 7pm is just a miss.",
            "expected_outcome": "You hit the solo bar — 40+ pitches, 3+ deals, 1+ membership, 80% valid — and you track it yourself through the day.",
        }),
        (8, "Replicate the Day", {
            "what_good_looks_like": "The proof of repeatability: hit the benchmark again — 40+ pitches, 3+ deals, 1+ membership — back to back. One good day is luck. Two in a row is a rep.",
            "expected_outcome": "You hit the benchmark two days running — 40+ pitches, 3+ deals, 1+ membership — proving yesterday wasn't luck.",
        }),
    ]
    fixes = []
    for day, topic, old in olds:
        seed = next((m for m in TRAINING_MANUAL
                     if m["day_number"] == day and m["topic"] == topic), None)
        if not seed:
            logger.warning(f"content_fixes: seed manual item D{day} '{topic}' not found — skipping fix")
            continue
        fixes.append({"day_number": day, "topic": topic, "old": old,
                      "new": {k: seed[k] for k in old}})
    return fixes


# ── Step runners ───────────────────────────────────────────────────────────


async def _fix_training_modules(db) -> tuple:
    """Matched-text replace across ALL offices (office_id None = global
    template included). A doc is fixed only when all three content fields
    still equal the old text exactly; anything else counts as admin-edited
    and is skipped. All-or-nothing per doc keeps the guarantee simple."""
    fixed = skipped = 0
    for fix in module_text_fixes():
        async for doc in db.training_modules.find({"stage": fix["stage"], "topic": fix["topic"]}):
            if all(doc.get(k) == fix["old"][k] for k in _MODULE_CONTENT_FIELDS):
                await db.training_modules.update_one(
                    {"id": doc["id"]}, {"$set": dict(fix["new"])}
                )
                fixed += 1
            else:
                skipped += 1
                logger.info(
                    f"content_fixes: module '{fix['topic']}' (office {doc.get('office_id')}) "
                    "differs from old seed text — admin-edited, skipped"
                )
    return fixed, skipped


async def _delete_orphan_modules(db) -> int:
    deleted = 0
    async for doc in db.training_modules.find({"topic": ORPHAN_MODULE_TOPIC}):
        if doc.get("trainee_content") == _ORPHAN_TRAINEE_CONTENT:
            await db.training_modules.delete_one({"id": doc["id"]})
            deleted += 1
        else:
            logger.info(
                f"content_fixes: orphan-topic module (office {doc.get('office_id')}) "
                "has edited content — left in place"
            )
    return deleted


async def _fix_training_manual(db) -> tuple:
    fixed = skipped = 0
    for fix in manual_text_fixes():
        async for doc in db.training_manual.find({"day_number": fix["day_number"], "topic": fix["topic"]}):
            if all(doc.get(k) == fix["old"][k] for k in fix["old"]):
                await db.training_manual.update_one(
                    {"_id": doc["_id"]}, {"$set": dict(fix["new"])}
                )
                fixed += 1
            else:
                skipped += 1
                logger.info(
                    f"content_fixes: manual item D{fix['day_number']} '{fix['topic']}' "
                    f"(office {doc.get('office_id')}) differs from old seed text — admin-edited, skipped"
                )
    return fixed, skipped


async def _backfill_checklist_office_ids(db) -> int:
    """Stamp office_id on legacy delivery_checklist rows via the
    assessment_id → daily_assessments.new_hire_id → new_hires.office_id join.
    Rows whose chain is broken (deleted hire/assessment) stay unstamped —
    they belong to no office and single-office updates matching
    office_id ∈ {office, None} treat them as harmless legacy rows."""
    aids = await db.delivery_checklist.distinct("assessment_id", {"office_id": None})
    aids = [a for a in aids if a]
    if not aids:
        return 0
    aid_to_hire = {}
    async for a in db.daily_assessments.find({"id": {"$in": aids}}, {"id": 1, "new_hire_id": 1}):
        aid_to_hire[a["id"]] = a.get("new_hire_id")
    hire_ids = sorted({h for h in aid_to_hire.values() if h})
    hire_to_office = {}
    async for h in db.new_hires.find({"id": {"$in": hire_ids}}, {"id": 1, "office_id": 1}):
        hire_to_office[h["id"]] = h.get("office_id")
    stamped = 0
    for aid in aids:
        office_id = hire_to_office.get(aid_to_hire.get(aid) or "")
        if not office_id:
            continue
        res = await db.delivery_checklist.update_many(
            {"assessment_id": aid, "office_id": None},
            {"$set": {"office_id": office_id}},
        )
        stamped += getattr(res, "modified_count", 0) or 0
    if stamped:
        logger.info(f"content_fixes: backfilled office_id on {stamped} delivery_checklist rows")
    return stamped


async def run_content_fixes(db) -> dict:
    """Run every fix. Each step is individually guarded so one failure never
    blocks the rest (or the app boot — server.py wraps the call as well)."""
    result = {"fixed": 0, "skipped_edited": 0, "orphan_modules_deleted": 0,
              "checklist_office_backfilled": 0}
    try:
        f, s = await _fix_training_modules(db)
        result["fixed"] += f
        result["skipped_edited"] += s
    except Exception as e:
        logger.warning(f"content_fixes: module text fixes failed: {e}")
    try:
        result["orphan_modules_deleted"] = await _delete_orphan_modules(db)
    except Exception as e:
        logger.warning(f"content_fixes: orphan module cleanup failed: {e}")
    try:
        f, s = await _fix_training_manual(db)
        result["fixed"] += f
        result["skipped_edited"] += s
    except Exception as e:
        logger.warning(f"content_fixes: manual text fixes failed: {e}")
    try:
        result["checklist_office_backfilled"] = await _backfill_checklist_office_ids(db)
    except Exception as e:
        logger.warning(f"content_fixes: checklist office_id backfill failed: {e}")
    try:
        from core.schedule_template import upgrade_office_schedules
        result["schedule_offices_upgraded"] = (await upgrade_office_schedules(db))["upgraded"]
    except Exception as e:
        logger.warning(f"content_fixes: schedule template upgrade failed: {e}")
    logger.info(f"content_fixes: {result}")
    return result
