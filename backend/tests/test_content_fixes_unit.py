"""Startup content-fixes: the whole point is healing live per-office docs
WITHOUT ever clobbering an admin's edit. These tests pin that contract:
matched-text replaces, edited docs skip, the orphan module only dies when it
still carries the orphan text, and legacy delivery_checklist rows get
office_id via the assessment → hire join.
"""
import asyncio
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.content_fixes import (  # noqa: E402
    run_content_fixes, module_text_fixes, manual_text_fixes,
    ORPHAN_MODULE_TOPIC, _ORPHAN_TRAINEE_CONTENT,
)


# ── Minimal in-memory Mongo stand-in (just the operators content_fixes uses) ──

class _Result:
    def __init__(self, matched=0, modified=0, deleted=0):
        self.matched_count = matched
        self.modified_count = modified
        self.deleted_count = deleted


def _field_match(doc, key, cond):
    exists = key in doc
    val = doc.get(key)
    if isinstance(cond, dict) and any(k.startswith("$") for k in cond):
        for op, arg in cond.items():
            if op == "$in":
                ok = any(v in arg for v in val) if isinstance(val, list) else val in arg
            elif op == "$exists":
                ok = exists == bool(arg)
            else:
                raise NotImplementedError(op)
            if not ok:
                return False
        return True
    if cond is None:  # Mongo: None matches missing OR explicit null
        return not exists or val is None
    return val == cond


def _match(doc, flt):
    for k, cond in (flt or {}).items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in cond):
                return False
        elif not _field_match(doc, k, cond):
            return False
    return True


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def sort(self, *a, **k):
        return self

    async def to_list(self, n=None):
        return list(self._rows[:n] if n else self._rows)

    def __aiter__(self):
        self._it = iter(self._rows)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _Coll:
    def __init__(self, rows=None):
        self.rows = [dict(r) for r in (rows or [])]

    def find(self, flt=None, proj=None):
        return _Cursor([dict(r) for r in self.rows if _match(r, flt)])

    async def find_one(self, flt=None, proj=None, **k):
        for r in self.rows:
            if _match(r, flt):
                return dict(r)
        return None

    async def update_one(self, flt, update):
        for r in self.rows:
            if _match(r, flt):
                r.update(update.get("$set", {}))
                return _Result(1, 1)
        return _Result(0, 0)

    async def update_many(self, flt, update):
        n = 0
        for r in self.rows:
            if _match(r, flt):
                r.update(update.get("$set", {}))
                n += 1
        return _Result(n, n)

    async def delete_one(self, flt):
        for i, r in enumerate(self.rows):
            if _match(r, flt):
                del self.rows[i]
                return _Result(deleted=1)
        return _Result()

    async def distinct(self, field, flt=None):
        return sorted({r.get(field) for r in self.rows if _match(r, flt)} - {None})


class _DB:
    def __init__(self):
        self.training_modules = _Coll()
        self.training_manual = _Coll()
        self.product_knowledge_topics = _Coll()
        self.product_exam_questions = _Coll()
        self.delivery_checklist = _Coll()
        self.daily_assessments = _Coll()
        self.new_hires = _Coll()


def _run(db):
    return asyncio.run(run_content_fixes(db))


# ── Module text fixes ─────────────────────────────────────────────────────

def _grasp_fix():
    return next(f for f in module_text_fixes() if f["topic"] == "GRASP")


def test_module_matching_old_seed_text_is_fixed_and_edited_copy_is_skipped():
    fix = _grasp_fix()
    db = _DB()
    db.training_modules = _Coll([
        # Boston: untouched since seeding — still the mangled GROW text
        {"id": "m1", "office_id": "boston", "stage": 2, "topic": "GRASP", **fix["old"]},
        # New Haven: an admin rewrote the trainee content — must survive
        {"id": "m2", "office_id": "newhaven", "stage": 2, "topic": "GRASP",
         **{**fix["old"], "trainee_content": "Our office's own GRASP notes."}},
    ])
    result = _run(db)
    m1 = next(r for r in db.training_modules.rows if r["id"] == "m1")
    m2 = next(r for r in db.training_modules.rows if r["id"] == "m2")
    assert m1["trainee_content"] == fix["new"]["trainee_content"]
    assert "Getting with the Right People" in m1["trainee_content"]  # the playbook's G.R.A.S.P, not GROW
    assert m2["trainee_content"] == "Our office's own GRASP notes."
    assert m2["leader_coaching_notes"] == fix["old"]["leader_coaching_notes"]
    assert result["fixed"] >= 1 and result["skipped_edited"] >= 1


def test_partial_field_edit_skips_the_whole_doc():
    # All-or-nothing: one edited field means the admin owns the doc now.
    fix = _grasp_fix()
    db = _DB()
    db.training_modules = _Coll([
        {"id": "m1", "office_id": None, "stage": 2, "topic": "GRASP",
         **{**fix["old"], "what_good_looks_like": ["Custom bullet"]}},
    ])
    _run(db)
    m1 = db.training_modules.rows[0]
    assert m1["trainee_content"] == fix["old"]["trainee_content"]
    assert m1["what_good_looks_like"] == ["Custom bullet"]


def test_orphan_module_deleted_only_when_content_still_matches():
    db = _DB()
    db.training_modules = _Coll([
        {"id": "o1", "office_id": "boston", "stage": 2, "topic": ORPHAN_MODULE_TOPIC,
         "trainee_content": _ORPHAN_TRAINEE_CONTENT},
        {"id": "o2", "office_id": "newhaven", "stage": 2, "topic": ORPHAN_MODULE_TOPIC,
         "trainee_content": "An admin made this their own module."},
    ])
    result = _run(db)
    ids = {r["id"] for r in db.training_modules.rows}
    assert ids == {"o2"}
    assert result["orphan_modules_deleted"] == 1


# ── Manual text fixes ─────────────────────────────────────────────────────

def test_manual_kpi_item_fixed_by_topic_even_after_reorder_and_edit_skipped():
    fix = next(f for f in manual_text_fixes() if f["topic"] == "Daily KPI Standard")
    db = _DB()
    db.training_manual = _Coll([
        # Boston admin reordered day 7, so the sequence moved — topic match
        # must still find and heal it.
        {"_id": 1, "office_id": "boston", "day_number": 7, "sequence": 9,
         "topic": "Daily KPI Standard", **fix["old"]},
        # New Haven admin rewrote the bar — must survive.
        {"_id": 2, "office_id": "newhaven", "day_number": 7, "sequence": 5,
         "topic": "Daily KPI Standard",
         **{**fix["old"], "what_good_looks_like": "Our bar: 50 pitches."}},
    ])
    result = _run(db)
    r1 = next(r for r in db.training_manual.rows if r["_id"] == 1)
    r2 = next(r for r in db.training_manual.rows if r["_id"] == 2)
    assert "80 spoken, 20 presented, 15 closed, 5 flow, 3 sign-ups" in r1["what_good_looks_like"]
    assert "80 spoken" in r1["expected_outcome"]
    assert r2["what_good_looks_like"] == "Our bar: 50 pitches."
    assert result["fixed"] >= 1 and result["skipped_edited"] >= 1


def test_run_is_idempotent():
    fix = _grasp_fix()
    db = _DB()
    db.training_modules = _Coll([
        {"id": "m1", "office_id": "boston", "stage": 2, "topic": "GRASP", **fix["old"]},
    ])
    first = _run(db)
    second = _run(db)
    assert first["fixed"] == 1
    # Second pass finds the NEW text (≠ old seed) — counted as skip, not re-fix
    assert second["fixed"] == 0
    assert db.training_modules.rows[0]["trainee_content"] == fix["new"]["trainee_content"]


# ── delivery_checklist office_id backfill ─────────────────────────────────

def test_checklist_backfill_stamps_office_via_assessment_hire_join():
    db = _DB()
    db.new_hires = _Coll([
        {"id": "h1", "office_id": "boston"},
        {"id": "h2", "office_id": "newhaven"},
    ])
    db.daily_assessments = _Coll([
        {"id": "a1", "new_hire_id": "h1"},
        {"id": "a2", "new_hire_id": "h2"},
        {"id": "a3", "new_hire_id": "gone-hire"},
    ])
    db.delivery_checklist = _Coll([
        {"id": "c1", "assessment_id": "a1", "manual_item_id": "D4-02"},
        {"id": "c2", "assessment_id": "a2", "manual_item_id": "D4-02"},
        # Already stamped — must not be rewritten
        {"id": "c3", "assessment_id": "a1", "manual_item_id": "D4-03", "office_id": "newhaven"},
        # Broken chain — stays unstamped
        {"id": "c4", "assessment_id": "a3", "manual_item_id": "D4-02"},
    ])
    result = _run(db)
    by_id = {r["id"]: r for r in db.delivery_checklist.rows}
    assert by_id["c1"]["office_id"] == "boston"
    assert by_id["c2"]["office_id"] == "newhaven"
    assert by_id["c3"]["office_id"] == "newhaven"
    assert "office_id" not in by_id["c4"]
    assert result["checklist_office_backfilled"] == 2
