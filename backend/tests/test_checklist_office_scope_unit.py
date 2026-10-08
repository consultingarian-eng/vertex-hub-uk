"""Cross-office checklist bleed: delivery_checklist rows historically had no
office_id, so a Boston admin's grade-option edit rewrote New Haven's in-flight
checklists (bulk path had NO office filter) while the office-filtered path
matched ZERO rows. These tests pin the fix: rows are stamped with the hire's
office at creation, and single-office propagation touches only that office's
rows plus unstamped legacy rows.
"""
import asyncio
import sys
from pathlib import Path

from bson import ObjectId

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import training_routes  # noqa: E402
from models import NewHireCreate, BulkGradeUpdate, ManualItemUpdate  # noqa: E402


# ── Minimal in-memory Mongo stand-in ──────────────────────────────────────

class _Result:
    def __init__(self, matched=0, modified=0):
        self.matched_count = matched
        self.modified_count = modified


def _field_match(doc, key, cond):
    val = doc.get(key)
    if isinstance(cond, dict) and any(k.startswith("$") for k in cond):
        for op, arg in cond.items():
            if op == "$in":
                ok = val in arg
            elif op == "$ne":
                ok = val != arg
            elif op == "$nin":
                ok = val not in arg
            else:
                raise NotImplementedError(op)
            if not ok:
                return False
        return True
    return val == cond


def _match(doc, flt):
    return all(_field_match(doc, k, cond) for k, cond in (flt or {}).items())


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def sort(self, *a, **k):
        return self

    async def to_list(self, n=None):
        return list(self._rows[:n] if n else self._rows)


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

    async def insert_one(self, doc):
        self.rows.append(dict(doc))

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


class _DB:
    def __init__(self):
        self.users = _Coll()
        self.new_hires = _Coll()
        self.daily_assessments = _Coll()
        self.delivery_checklist = _Coll()
        self.training_manual = _Coll()
        self.offices = _Coll()


ADMIN = {"id": "admin1", "name": "Ada Admin", "role": "admin", "office_id": "office-A"}


def _patch(monkeypatch, db):
    async def _user(_request):
        return dict(ADMIN)

    async def _office(_request, _user=None, _office=None):
        return "office-A"

    monkeypatch.setattr(training_routes, "db", db)
    monkeypatch.setattr(training_routes, "get_current_user", _user)
    monkeypatch.setattr(training_routes, "require_admin", _user)
    monkeypatch.setattr(training_routes, "resolve_office_id", _office)


# ── Creation stamps office_id ─────────────────────────────────────────────

def test_new_hire_checklist_rows_are_stamped_with_the_hires_office(monkeypatch):
    db = _DB()
    leader_oid = ObjectId()
    db.users = _Coll([{"_id": leader_oid, "name": "Lena Leader", "role": "leader",
                       "office_id": "office-A"}])
    db.training_manual = _Coll([
        {"day_number": 1, "sequence": 1, "category": "Behaviour", "topic": "Work Ethic",
         "confidence_expected": "Understand", "grade_options": ["Learnt", "Not Learnt"],
         "office_id": "office-A"},
        # Another office's manual item for the same day must not leak in
        {"day_number": 1, "sequence": 1, "category": "Behaviour", "topic": "Other Office",
         "office_id": "office-B"},
    ])
    _patch(monkeypatch, db)
    hire = NewHireCreate(name="Terry Trainee", leader="Lena Leader",
                         leader_id=str(leader_oid), start_date="2026-08-17")
    asyncio.run(training_routes.create_new_hire(hire, request=None))
    assert db.delivery_checklist.rows, "creation should build checklist rows"
    assert all(r.get("office_id") == "office-A" for r in db.delivery_checklist.rows)
    assert all(r.get("topic") == "Work Ethic" for r in db.delivery_checklist.rows)


# ── Single-office grade propagation is office-isolated ────────────────────

def _grade_db():
    db = _DB()
    db.training_manual = _Coll([
        {"day_number": 4, "sequence": 2, "office_id": "office-A", "grade_options": ["Old"]},
        {"day_number": 4, "sequence": 2, "office_id": "office-B", "grade_options": ["Old"]},
    ])
    db.delivery_checklist = _Coll([
        {"id": "cA", "manual_item_id": "D4-02", "office_id": "office-A",
         "grade": "Old", "grade_options": ["Old"]},
        {"id": "cB", "manual_item_id": "D4-02", "office_id": "office-B",
         "grade": "Old", "grade_options": ["Old"]},
        # Legacy row without office_id (pre-stamping) — still updatable
        {"id": "cL", "manual_item_id": "D4-02", "grade": "Old", "grade_options": ["Old"]},
    ])
    return db


def test_bulk_grade_update_leaves_other_offices_checklists_alone(monkeypatch):
    db = _grade_db()
    _patch(monkeypatch, db)
    req = BulkGradeUpdate(items=[{"day_number": 4, "sequence": 2,
                                  "grade_options": ["Excellent", "Average"]}])
    asyncio.run(training_routes.bulk_update_grade_options(req, request=None))
    by_id = {r["id"]: r for r in db.delivery_checklist.rows}
    assert by_id["cA"]["grade_options"] == ["Excellent", "Average"]
    assert by_id["cA"]["grade"] is None  # "Old" is no longer a valid grade
    assert by_id["cL"]["grade_options"] == ["Excellent", "Average"]
    # The bug: this row used to be rewritten too (no office filter at all)
    assert by_id["cB"]["grade_options"] == ["Old"]
    assert by_id["cB"]["grade"] == "Old"
    # And office-B's manual item itself is untouched
    assert db.training_manual.rows[1]["grade_options"] == ["Old"]


def test_single_item_update_propagates_only_within_the_office(monkeypatch):
    db = _grade_db()
    _patch(monkeypatch, db)
    upd = ManualItemUpdate(grade_options=["Excellent", "Average"])
    asyncio.run(training_routes.update_manual_item(4, 2, upd, request=None))
    by_id = {r["id"]: r for r in db.delivery_checklist.rows}
    # The old filter (office_id == exact office) matched ZERO rows; now the
    # office's stamped rows and unstamped legacy rows both update.
    assert by_id["cA"]["grade_options"] == ["Excellent", "Average"]
    assert by_id["cL"]["grade_options"] == ["Excellent", "Average"]
    assert by_id["cB"]["grade_options"] == ["Old"]
