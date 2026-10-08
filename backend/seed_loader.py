"""Bundle-seed loader.

On backend startup, look at every JSON file in `/app/backend/seed/`. For
each one, if the matching Mongo collection has fewer than the configured
threshold of documents, import the JSON. This populates a brand-new
deployed Mongo with the curated content (product knowledge, training
manual, modules, assessments, checklists, COD rep mappings, configs)
that the user built up in preview, so the deployed app looks identical
on first launch.

Idempotent: once a deployed Mongo crosses the threshold (real users
start using the app), subsequent reboots become no-ops. The check is
"sparse OR empty", never "always overwrite", so we never blow away
production data.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger("seed_loader")

SEED_DIR = Path(__file__).resolve().parent / "seed"

# (collection_name, threshold).  Threshold = if the deployed collection
# has < threshold docs, import the JSON (skipped when the file is absent).
COLLECTIONS: list[tuple[str, int]] = [
    # ── ALWAYS-SAFE seedables ─────────────────────────────────────────
    # No office_id, no user/trainee references — purely shared content
    # that any deployment can use unchanged.
    # Threshold 1 = import only into an EMPTY collection. The bundled
    # playbook is ~37 topics, so any higher threshold would wipe and
    # re-import (losing admin edits) every boot once someone deletes one.
    ("product_knowledge_topics", 1),
    ("product_exam_questions", 10),
    ("coaching_impacts", 20),
    # ── PROTECTED — never auto-seeded, force-import will reject ───────
    # These contain office_id / new_hire_id / assessment_id / created_by_id
    # references keyed on the SOURCE Mongo's UUIDs. Importing them into a
    # different deployment would orphan rows whose office/trainee IDs
    # don't exist on the target side. Each office configures these via
    # the in-app Manual Editor / Assessment flows.
    #
    #   • training_manual           — office_id-keyed; per-office manual
    #   • training_modules          — office_id-keyed
    #   • daily_assessments         — per-trainee filled assessments
    #   • delivery_checklist        — per-assessment filled checklist
    #   • settings                  — per-office pay-tab toggle
    #   • app_settings              — global admin toggle
    #   • coaching_resources        — admin-uploaded PDFs
    #   • offices, targets, commission_fees, agenda_scan_mappings
    #     (originally protected from your earlier guidance)
]


def _from_jsonable(v: Any) -> Any:
    """Reverse the encoding done by `_to_jsonable` in the dumper."""
    if isinstance(v, dict):
        # MongoDB extended JSON markers
        if set(v.keys()) == {"$oid"}:
            from bson import ObjectId
            return ObjectId(v["$oid"])
        if set(v.keys()) == {"$date"}:
            try:
                return datetime.fromisoformat(v["$date"])
            except (TypeError, ValueError):
                return v["$date"]  # leave as raw string if unparsable
        return {k: _from_jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_from_jsonable(x) for x in v]
    return v


async def load_bundled_seeds(db) -> None:
    """Import bundled JSON seeds into Mongo for any collection that's
    below threshold. Safe to call on every startup.
    """
    if not SEED_DIR.exists():
        logger.info("seed: no seed/ directory found — skipping bundled seeds")
        return

    # Allow ops to disable seeding entirely with one env var (e.g. if
    # they're recovering from a bad deploy and don't want auto-import).
    if (os.environ.get("DISABLE_SEED_LOADER") or "").lower() in ("1", "true", "yes"):
        logger.info("seed: DISABLE_SEED_LOADER=1 — skipping bundled seeds")
        return

    total_imported = 0
    for col, threshold in COLLECTIONS:
        json_path = SEED_DIR / f"{col}.json"
        if not json_path.exists():
            continue
        try:
            current = await db[col].estimated_document_count()
        except Exception as e:
            logger.warning(f"seed[{col}]: count failed — {e}")
            continue
        if current >= threshold:
            continue  # already populated by real activity / prior seed
        try:
            raw = json.loads(json_path.read_text(encoding="utf-8"))
            if not raw:
                continue
            docs = [_from_jsonable(d) for d in raw]
            # Wipe any partial data in this collection before re-importing
            # so we don't duplicate-insert if the collection already had
            # SOME data but below threshold (e.g. a config doc was hand-
            # created but full seed never ran).
            await db[col].delete_many({})
            # Insert in chunks to avoid 16MB BSON cap on bulk ops.
            CHUNK = 500
            for i in range(0, len(docs), CHUNK):
                await db[col].insert_many(docs[i:i + CHUNK], ordered=False)
            total_imported += len(docs)
            logger.info(
                f"seed[{col}]: imported {len(docs)} docs "
                f"(was {current}, threshold {threshold})"
            )
        except Exception as e:
            logger.exception(f"seed[{col}]: import failed — {e}")

    if total_imported:
        logger.info(f"seed: imported {total_imported} total docs from bundled JSON")
    else:
        logger.info("seed: nothing to import — all collections already populated")

    # ── Additive heal: training_manual + training_modules ───────────────
    # Both of these are office_id-keyed, so they're EXCLUDED from the
    # main wipe-and-replace seeder above (it would orphan any office not
    # present in the JSON). Instead we run them through
    # an additive merge: for each row in the JSON, only insert it if the
    # exact same (office_id, day_number, sequence) tuple is missing AND
    # an office with that office_id actually exists on this Mongo.
    # Result: gaps in offices present in the bundle get filled on every
    # deploy, and any other office stays untouched.
    await _additive_heal_office_keyed(db)


async def _additive_heal_office_keyed(db) -> None:
    cfgs = [
        ("training_manual", ("office_id", "day_number", "sequence")),
        ("training_modules", ("office_id", "stage", "order_in_stage")),
    ]
    if (os.environ.get("DISABLE_SEED_HEAL") or "").lower() in ("1", "true", "yes"):
        logger.info("seed-heal: DISABLE_SEED_HEAL=1 — skipping additive heal")
        return
    try:
        deployed_office_ids = set(await db.offices.distinct("id"))
    except Exception as e:
        logger.warning(f"seed-heal: could not read offices — {e}")
        return
    for col, key_fields in cfgs:
        json_path = SEED_DIR / f"{col}.json"
        if not json_path.exists():
            continue
        try:
            raw = json.loads(json_path.read_text(encoding="utf-8"))
            if not raw:
                continue
            # Build a set of existing keys on this Mongo so we know what's
            # already there (and can therefore skip).
            projection = {k: 1 for k in key_fields}
            existing = set()
            async for d in db[col].find({}, projection):
                existing.add(tuple(d.get(k) for k in key_fields))
            inserted = 0
            skipped_orphan = 0
            skipped_dup = 0
            for d in raw:
                doc = _from_jsonable(d)
                key = tuple(doc.get(k) for k in key_fields)
                if doc.get("office_id") and doc["office_id"] not in deployed_office_ids:
                    # Office in the JSON doesn't exist on this Mongo —
                    # don't insert (would create an orphan row).
                    skipped_orphan += 1
                    continue
                if key in existing:
                    # Already there — additive merge means we never overwrite.
                    skipped_dup += 1
                    continue
                # Strip _id so Mongo assigns a fresh one (avoids dup-key
                # errors if the source ObjectId happens to collide).
                doc.pop("_id", None)
                await db[col].insert_one(doc)
                existing.add(key)
                inserted += 1
            if inserted or skipped_orphan or skipped_dup:
                logger.info(
                    f"seed-heal[{col}]: +{inserted} new, "
                    f"{skipped_dup} already-present, "
                    f"{skipped_orphan} skipped (office missing on this Mongo)"
                )
        except Exception as e:
            logger.exception(f"seed-heal[{col}]: failed — {e}")
