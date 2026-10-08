"""Focused tests for achievement thresholds and idempotent award behavior."""

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import achievements


def test_catalog_has_unique_keys_for_every_configured_tier():
    keys = [item["key"] for item in achievements.ACHIEVEMENTS]
    configured = {
        key
        for tiers in (
            achievements.DAY_SALES_TIERS,
            achievements.PERSONAL_WEEK_TIERS,
            achievements.TEAM_WEEK_TIERS,
            achievements.LEARNING_DAY_MILESTONES,
        )
        for _threshold, key in tiers
    } | set(achievements.MODULE_STAGE_KEYS.values())

    assert len(keys) == len(set(keys))
    assert configured <= set(keys)


def test_sales_badges_use_worked_sales_not_memberships_or_stale_statuses():
    membership_only = [
        {"status": "in", "over30": 0, "under30": 0, "memberships": 40},
    ]
    stale_off_sales = [
        {"status": "off", "over30": 10, "under30": 10, "memberships": 0},
    ]
    # The owner's What Good Looks Like: Green is 8-9 sign-ups a week, Amber
    # 6-7 — so 8 earns the Green Week badge and 7 does not.
    green_week = [
        {"status": "in", "over30": 1, "under30": 1, "memberships": 20}
        for _ in range(4)
    ]
    amber_week = green_week[:3] + [{"status": "in", "over30": 1, "under30": 0, "memberships": 0}]
    superstar_green_week = green_week + [
        {"status": "in", "over30": 6, "under30": 6, "memberships": 0},
    ]

    assert achievements._sales_badge_keys(membership_only) == []
    assert achievements._sales_badge_keys(stale_off_sales) == []
    assert achievements._sales_badge_keys(amber_week) == ["first_sale"]
    assert achievements._sales_badge_keys(green_week) == ["first_sale", "personal_12"]
    assert achievements._sales_badge_keys(superstar_green_week) == [
        "first_sale",
        "first_bell",
        "first_gong",
        "superstar_10",
        "personal_12",
        "personal_20",
    ]


def test_stage1_badges_cover_early_green_completion_and_mastery():
    assert achievements._stage1_badge_keys([
        {"day_number": 1, "completed": True, "overall_score": 9},
    ]) == ["green_day"]

    all_green = [
        {"day_number": day, "completed": True, "overall_score": 9}
        for day in range(1, 9)
    ]
    one_yellow = [*all_green[:-1], {"day_number": 8, "completed": True, "overall_score": 8.9}]

    assert achievements._stage1_badge_keys(all_green) == [
        "green_day",
        "stage1_complete",
        "stage1_green",
    ]
    assert achievements._stage1_badge_keys(one_yellow) == [
        "green_day",
        "stage1_complete",
    ]


def test_learning_days_add_attainable_early_wins_without_streak_logic(monkeypatch):
    awarded = []

    async def fake_award(_user_id, key, **_kwargs):
        awarded.append(key)
        return True

    monkeypatch.setattr(achievements, "award", fake_award)
    asyncio.run(achievements.award_learning_days("user-1", 5))

    assert awarded == ["learn_1", "learn_5"]


def test_quiz_badges_are_stage_2_or_3_only(monkeypatch):
    awarded = []

    async def fake_award(_user_id, key, **_kwargs):
        awarded.append(key)
        return True

    monkeypatch.setattr(achievements, "award", fake_award)
    stage_2 = asyncio.run(achievements.award_quiz_badges("user-1", 3, 3, True, 2))
    stage_4 = asyncio.run(achievements.award_quiz_badges("user-1", 3, 3, True, 4))

    assert list(stage_2) == ["quiz_pass", "quiz_perfect"]
    assert stage_4 == {}
    assert awarded == ["quiz_pass", "quiz_perfect"]
    assert achievements._quiz_badge_keys(3, 3, False) == ["quiz_pass", "quiz_perfect"]


def test_award_uses_one_atomic_upsert(monkeypatch):
    class BadgeCollection:
        def __init__(self):
            self.calls = []
            self.next_upserted_id = "new-id"

        async def update_one(self, query, update, upsert=False):
            self.calls.append((query, update, upsert))
            return SimpleNamespace(upserted_id=self.next_upserted_id)

    badges = BadgeCollection()
    monkeypatch.setattr(achievements, "db", SimpleNamespace(user_badges=badges))

    assert asyncio.run(achievements.award("user-1", "learn_1", notify=False)) is True
    query, update, upsert = badges.calls[0]
    assert query == {"user_id": "user-1", "key": "learn_1"}
    assert update["$setOnInsert"]["key"] == "learn_1"
    assert upsert is True

    badges.next_upserted_id = None
    assert asyncio.run(achievements.award("user-1", "learn_1", notify=False)) is False


def test_module_stage_completion_ignores_malformed_module_ids(monkeypatch):
    user_id = "0123456789abcdef01234567"

    class Users:
        async def find_one(self, _query, _projection):
            return {"office_id": "office-1"}

    class Modules:
        async def distinct(self, _field, _query):
            return [None, "", "module-1", "module-2"]

    class Progress:
        async def distinct(self, _field, _query):
            return ["module-1", "module-2"]

    awarded = []

    async def fake_award(_user_id, key, **_kwargs):
        awarded.append(key)
        return True

    monkeypatch.setattr(
        achievements,
        "db",
        SimpleNamespace(users=Users(), training_modules=Modules(), module_progress=Progress()),
    )
    monkeypatch.setattr(achievements, "award", fake_award)

    result = asyncio.run(achievements.award_module_stage_completion(user_id, 2))
    assert result is True
    assert awarded == ["stage2_complete"]


class _AsyncCursor:
    """Minimal async iterable standing in for a Motor find() cursor."""

    def __init__(self, docs):
        self._docs = list(docs)

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


def _reconcile_db(monkeypatch, held, weeks, deleted):
    class Bells:
        def find(self, _query, _projection):
            return _AsyncCursor(weeks)

    class Badges:
        async def distinct(self, _field, query):
            return [k for k in held if k in query["key"]["$in"]]

        async def delete_many(self, query):
            keys = query["key"]["$in"]
            deleted.extend(keys)
            return SimpleNamespace(deleted_count=len(keys))

    monkeypatch.setattr(
        achievements, "db", SimpleNamespace(bells_entries=Bells(), user_badges=Badges())
    )


def test_reconcile_revokes_badge_after_downward_correction(monkeypatch):
    # Rep unlocked First Gong (5/day) from a mis-keyed entry; the fixed board
    # now tops out at 2 sales in a day, so first_gong must be pulled while the
    # legitimately-earned first_sale stays.
    deleted = []
    _reconcile_db(
        monkeypatch,
        held=["first_sale", "first_gong"],
        weeks=[{"week_ending": "2026-07-19", "days": [{"status": "in", "over30": 1, "under30": 1}]}],
        deleted=deleted,
    )
    revoked = asyncio.run(achievements.reconcile_sales_badges("user-1"))
    assert revoked == ["first_gong"]
    assert deleted == ["first_gong"]


def test_reconcile_keeps_badge_the_data_still_supports(monkeypatch):
    # Still a real 5-sale day on the board — nothing should be revoked and no
    # delete should even be issued.
    deleted = []
    _reconcile_db(
        monkeypatch,
        held=["first_sale", "first_gong"],
        weeks=[{"week_ending": "2026-07-19", "days": [{"status": "in", "over30": 3, "under30": 2}]}],
        deleted=deleted,
    )
    revoked = asyncio.run(achievements.reconcile_sales_badges("user-1"))
    assert revoked == []
    assert deleted == []


def test_reconcile_no_op_when_rep_holds_no_sales_badges(monkeypatch):
    # No revocable badge held → bail before ever scanning the bells board.
    scanned = {"find": 0}

    class Bells:
        def find(self, _query, _projection):
            scanned["find"] += 1
            return _AsyncCursor([])

    class Badges:
        async def distinct(self, _field, _query):
            return []

    monkeypatch.setattr(
        achievements, "db", SimpleNamespace(bells_entries=Bells(), user_badges=Badges())
    )
    assert asyncio.run(achievements.reconcile_sales_badges("user-1")) == []
    assert scanned["find"] == 0
