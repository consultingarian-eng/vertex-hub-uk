"""Adding a trainee gives them a full 8-day training record.

Every surviving add-trainee path — the Add Trainee screen (POST /new-hires)
and the admin Add User form (POST /admin/create-user) — must leave the
trainee with a `new_hires` row, Day 1–8 Pending daily assessments, and a
delivery checklist per day built from the office's training manual. These
pin that behaviour through the shared helper in core/trainee_records.py.

Pure in-memory: mongomock, no network.
"""
import asyncio
import sys
from pathlib import Path

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import trainee_records  # noqa: E402
from models import NewHireCreate  # noqa: E402
from routes import admin_routes, training_routes  # noqa: E402

OFFICE = "office-head"
OTHER_OFFICE = "office-other"


def _db():
    return AsyncMongoMockClient()["trainee_records_test"]


async def _seed_office(db):
    await db.offices.insert_one({"id": OFFICE, "name": "Head Office"})
    # Two manual items on Day 1, one on Day 8, plus another office's item
    # that must never leak into this office's checklists.
    await db.training_manual.insert_many([
        {"day_number": 1, "sequence": 2, "topic": "Door approach", "category": "Skill",
         "office_id": OFFICE},
        {"day_number": 1, "sequence": 1, "topic": "Work ethic", "category": "Behaviour",
         "office_id": OFFICE, "grade_options": ["Learnt", "Not Learnt"]},
        {"day_number": 8, "sequence": 1, "topic": "Review", "category": "Skill",
         "office_id": OFFICE},
        {"day_number": 1, "sequence": 1, "topic": "Other office", "category": "Skill",
         "office_id": OTHER_OFFICE},
    ])


async def _assert_full_record(db, hire_id, name):
    hire = await db.new_hires.find_one({"id": hire_id})
    assert hire and hire["active"] is True and hire["office_id"] == OFFICE
    assessments = await db.daily_assessments.find({"new_hire_id": hire_id}).to_list(50)
    assert sorted(a["day_number"] for a in assessments) == list(range(1, 9))
    assert all(a["status"] == "Pending" and a["completed"] is False for a in assessments)
    assert all(a["new_hire_name"] == name for a in assessments)
    by_day = {a["day_number"]: a["id"] for a in assessments}
    day1 = await db.delivery_checklist.find({"assessment_id": by_day[1]}).to_list(50)
    assert [r["topic"] for r in sorted(day1, key=lambda r: r["manual_item_id"])] == ["Work ethic", "Door approach"]
    assert all(r["office_id"] == OFFICE for r in day1)
    assert {r["manual_item_id"] for r in day1} == {"D1-01", "D1-02"}
    assert next(r for r in day1 if r["topic"] == "Work ethic")["grade_options"] == ["Learnt", "Not Learnt"]
    day8 = await db.delivery_checklist.find({"assessment_id": by_day[8]}).to_list(50)
    assert [r["topic"] for r in day8] == ["Review"]
    # Days with no manual items still get their assessment, just no checklist.
    assert await db.delivery_checklist.count_documents({"assessment_id": by_day[4]}) == 0
    return hire


def test_create_training_record_builds_hire_assessments_and_checklists():
    async def go():
        db = _db()
        await _seed_office(db)
        uid = ObjectId()
        await db.users.insert_one({"_id": uid, "name": "Terry Trainee", "role": "trainee"})
        hire = await trainee_records.create_training_record(
            db, name="Terry Trainee", office_id=OFFICE, trainee_user_id=str(uid),
        )
        await _assert_full_record(db, hire["id"], "Terry Trainee")
        assert hire["leader"] == "Unassigned"
        assert hire["trainee_user_id"] == str(uid)
        user = await db.users.find_one({"_id": uid})
        assert user["new_hire_id"] == hire["id"]
    asyncio.run(go())


def test_add_trainee_screen_path_creates_full_record(monkeypatch):
    async def go():
        db = _db()
        await _seed_office(db)
        leader_oid = ObjectId()
        await db.users.insert_one({"_id": leader_oid, "name": "Lena Leader", "role": "leader",
                                   "office_id": OFFICE})
        admin = {"id": str(ObjectId()), "name": "Ada Admin", "role": "admin", "office_id": OFFICE}

        async def _user(_request):
            return dict(admin)

        async def _no_award(*_a, **_k):
            return None

        monkeypatch.setattr(training_routes, "db", db)
        monkeypatch.setattr(training_routes, "get_current_user", _user)
        monkeypatch.setattr(training_routes, "award", _no_award)
        hire = NewHireCreate(name="Tia Trainee", leader_id=str(leader_oid),
                             start_date="2026-10-05", campaign="Winter appeal",
                             email="tia@example.com", password="correct-horse-9")
        out = await training_routes.create_new_hire(hire, request=None)
        saved = await _assert_full_record(db, out.id, "Tia Trainee")
        assert saved["leader"] == "Lena Leader"
        assert saved["campaign"] == "Winter appeal"
        trainee = await db.users.find_one({"email": "tia@example.com"})
        assert trainee["role"] == "trainee" and trainee["new_hire_id"] == out.id
        assert trainee["reports_to"] == str(leader_oid)
    asyncio.run(go())


class _JsonRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def test_admin_add_user_trainee_path_creates_full_record(monkeypatch):
    async def go():
        db = _db()
        await _seed_office(db)
        admin = {"id": str(ObjectId()), "name": "Ada Admin", "role": "admin", "office_id": OFFICE}

        async def _user(_request):
            return dict(admin)

        sent = []
        monkeypatch.setattr(admin_routes, "db", db)
        monkeypatch.setattr(admin_routes, "require_admin", _user)
        monkeypatch.setattr(admin_routes, "get_current_user", _user)
        monkeypatch.setattr(admin_routes, "send_admin_created_account_email",
                            lambda **kw: sent.append(kw))
        out = await admin_routes.admin_create_user(_JsonRequest({
            "name": "Sam Starter", "email": "sam@example.com",
            "password": "correct-horse-9", "role": "trainee",
        }))
        user = await db.users.find_one({"_id": ObjectId(out["id"])})
        assert user["role"] == "trainee" and user["office_id"] == OFFICE
        assert user.get("new_hire_id")
        hire = await _assert_full_record(db, user["new_hire_id"], "Sam Starter")
        assert hire["trainee_user_id"] == out["id"]
        assert sent and sent[0]["email"] == "sam@example.com"
    asyncio.run(go())


def test_admin_add_user_leader_path_creates_no_training_record(monkeypatch):
    async def go():
        db = _db()
        await _seed_office(db)
        admin = {"id": str(ObjectId()), "name": "Ada Admin", "role": "admin", "office_id": OFFICE}

        async def _user(_request):
            return dict(admin)

        monkeypatch.setattr(admin_routes, "db", db)
        monkeypatch.setattr(admin_routes, "require_admin", _user)
        monkeypatch.setattr(admin_routes, "get_current_user", _user)
        monkeypatch.setattr(admin_routes, "send_admin_created_account_email", lambda **kw: None)
        await admin_routes.admin_create_user(_JsonRequest({
            "name": "Lou Leader", "email": "lou@example.com",
            "password": "correct-horse-9", "role": "leader", "send_email": False,
        }))
        assert await db.new_hires.count_documents({}) == 0
        assert await db.daily_assessments.count_documents({}) == 0
    asyncio.run(go())
