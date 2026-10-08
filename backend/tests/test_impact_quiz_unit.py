"""Leadership Hub impact quizzes — unit tests.

The COD revamp adds a LEARN mode to /coaching impacts, backed by three
endpoints in routes/coaching.py that mirror routes/modules.py's module-quiz
contract EXACTLY (so the frontend reuses the module-quiz UI unchanged):

  • GET  /coaching/impacts/{id}/quiz         → same shape as GET /modules/{id}/quiz
  • POST /coaching/impacts/{id}/quiz/submit  → same shape as module quiz submit
  • GET  /coaching/impacts/{id}/quiz-state   → {passed, score, total, passed_at}

Covered here:
  • contract drift-guard: the coaching GET + submit response shapes are
    compared against the LIVE modules.py endpoints' shapes (not a copy)
  • content-hash cache: hit path never regenerates; edited content does
  • grading (pass = 2/3), answers never leave the server
  • pass persistence in coaching_impact_quiz_passes (best-score upsert)
  • audience scoping (leader/trainee/core-leader/admin stage gates)
  • 404-when-generation-unavailable path

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""
import asyncio
import hashlib
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import coaching, modules  # noqa: E402
from routes.coaching import ImpactQuizSubmit  # noqa: E402
from routes.modules import QuizSubmit  # noqa: E402


def _db():
    return AsyncMongoMockClient()["cg1_impact_quiz_test"]


def _run(coro):
    return asyncio.run(coro)


ADMIN = {"id": "u-admin", "name": "Ada", "role": "admin", "office_id": "office-A"}
LEADER = {"id": "u-leader", "name": "Lena", "role": "leader", "office_id": "office-A"}
CORE_LEADER = {"id": "u-core", "name": "Cora", "role": "leader",
               "office_id": "office-A", "is_core_leader": True}
TRAINEE = {"id": "u-trainee", "name": "Terry", "role": "trainee",
           "office_id": "office-A", "new_hire_id": "hire-1"}

IMPACT_BODY = (
    "The Cycle of Development is how a leader turns raw effort into repeatable "
    "skill: observe, demonstrate, let them try, debrief, repeat. Never skip the "
    "debrief — that is where the learning actually lands."
)


def _impact(stage=2, body=IMPACT_BODY, **over):
    d = {
        "id": "imp-1",
        "title": "Cycle of Development",
        "summary": "How skills actually get built.",
        "body": body,
        "key_takeaways": ["Debrief every rep", "Demonstrate before delegating"],
        "stage": stage,
        "category": "leadership",
        "source": "Impact Booklet",
        "order": 1,
    }
    d.update(over)
    return d


def _questions():
    return [
        {"id": f"q{i}", "question": f"Question {i}?",
         "choices": ["a", "b", "c", "d"], "answer": i % 4}
        for i in range(3)
    ]


# Answers keyed by question id: q0 right (0), q1 right (1), q2 wrong (0 vs 2)
ANSWERS_2_OF_3 = {"q0": 0, "q1": 1, "q2": 0}
ANSWERS_0_OF_3 = {"q0": 3, "q1": 3, "q2": 0}
ANSWERS_3_OF_3 = {"q0": 0, "q1": 1, "q2": 2}


def _patch_coaching(monkeypatch, db, user):
    async def _user(_request):
        return dict(user)

    monkeypatch.setattr(coaching, "db", db)
    monkeypatch.setattr(coaching, "get_current_user", _user)


def _patch_modules(monkeypatch, db, user):
    async def _user(_request):
        return dict(user)

    async def _award(*_a, **_k):
        return None

    monkeypatch.setattr(modules, "db", db)
    monkeypatch.setattr(modules, "get_current_user", _user)
    monkeypatch.setattr(modules, "award_quiz_badges", _award)


def _seed_cached_impact_quiz(db, impact, quiz_id="quiz-1", questions=None):
    doc = {
        "id": quiz_id,
        "impact_id": impact["id"],
        "content_hash": coaching._impact_quiz_hash(impact),
        "questions": questions or _questions(),
        "created_at": "2026-08-18T00:00:00+00:00",
    }
    _run(db.coaching_impact_quizzes.insert_one(dict(doc)))
    return doc


def _forbid_generation(monkeypatch):
    async def _boom(*_a, **_k):  # pragma: no cover - the point is it never runs
        raise AssertionError("quiz generation must not be called on a cache hit")

    monkeypatch.setattr(coaching, "_generate_impact_quiz_questions", _boom)


def _stub_generation(monkeypatch, questions=None):
    async def _gen(*_a, **_k):
        return questions if questions is not None else _questions()

    monkeypatch.setattr(coaching, "_generate_impact_quiz_questions", _gen)


# ── Contract drift-guard: shapes come from the LIVE modules.py endpoints ──

MODULE_CONTENT = (
    "Door approach: smile, thumb over shoulder, open with the neighbour line. "
    "Assume the sale and keep the pen moving while you talk."
)
MODULE_GOOD = ["Relaxed body language", "Neighbour name-drop in first line"]


def _seed_module_with_cached_quiz(db):
    m = {"id": "mod-1", "stage": 2, "office_id": "office-A", "topic": "Doors",
         "trainee_content": MODULE_CONTENT, "what_good_looks_like": MODULE_GOOD}
    _run(db.training_modules.insert_one(dict(m)))
    content = MODULE_CONTENT.strip()
    extra = "\n".join(MODULE_GOOD)
    h = hashlib.sha1((content + "\n" + extra).encode("utf-8")).hexdigest()[:16]
    _run(db.module_quizzes.insert_one({
        "id": "mquiz-1", "module_id": "mod-1", "content_hash": h,
        "questions": _questions(), "created_at": "2026-08-18T00:00:00+00:00",
    }))
    return m


def _shape(obj):
    """Recursive key/type skeleton used to compare response contracts."""
    if isinstance(obj, dict):
        return {k: _shape(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_shape(x) for x in obj]
    return type(obj).__name__


def test_get_quiz_shape_matches_module_quiz_endpoint(monkeypatch):
    db = _db()
    _seed_module_with_cached_quiz(db)
    _patch_modules(monkeypatch, db, LEADER)
    module_resp = _run(modules.get_module_quiz("mod-1", request=None))

    impact = _impact()
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, LEADER)
    _forbid_generation(monkeypatch)
    impact_resp = _run(coaching.get_impact_quiz("imp-1", request=None))

    assert _shape(impact_resp) == _shape(module_resp)
    assert impact_resp["quiz_id"] == "quiz-1"
    assert len(impact_resp["questions"]) == 3
    # Correct answers never leave the server
    for q in impact_resp["questions"]:
        assert set(q.keys()) == {"id", "question", "choices"}


def test_submit_shape_matches_module_submit_endpoint(monkeypatch):
    db = _db()
    _seed_module_with_cached_quiz(db)
    _patch_modules(monkeypatch, db, LEADER)
    module_resp = _run(modules.submit_module_quiz(
        "mod-1", QuizSubmit(quiz_id="mquiz-1", answers=ANSWERS_2_OF_3), request=None))

    impact = _impact()
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, LEADER)
    impact_resp = _run(coaching.submit_impact_quiz(
        "imp-1", ImpactQuizSubmit(quiz_id="quiz-1", answers=ANSWERS_2_OF_3), request=None))

    assert _shape(impact_resp) == _shape(module_resp)
    # Identical inputs → identical grading on both sides
    assert impact_resp["score"] == module_resp["score"] == 2
    assert impact_resp["total"] == module_resp["total"] == 3
    assert impact_resp["passed"] is True and module_resp["passed"] is True


# ── Cache behaviour ───────────────────────────────────────────────────────

def test_cache_hit_never_regenerates(monkeypatch):
    db = _db()
    impact = _impact()
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, LEADER)
    _forbid_generation(monkeypatch)

    out = _run(coaching.get_impact_quiz("imp-1", request=None))
    assert out["quiz_id"] == "quiz-1"
    assert _run(db.coaching_impact_quizzes.count_documents({})) == 1


def test_edited_content_regenerates_and_caches_under_new_hash(monkeypatch):
    db = _db()
    impact = _impact()
    _run(db.coaching_impacts.insert_one(dict(impact)))
    # Cached quiz for an OLD version of the text
    _run(db.coaching_impact_quizzes.insert_one({
        "id": "quiz-stale", "impact_id": "imp-1", "content_hash": "deadbeefdeadbeef",
        "questions": _questions(), "created_at": "2026-01-01T00:00:00+00:00",
    }))
    _patch_coaching(monkeypatch, db, LEADER)
    _stub_generation(monkeypatch)

    out = _run(coaching.get_impact_quiz("imp-1", request=None))
    assert out["quiz_id"] != "quiz-stale"
    fresh = _run(db.coaching_impact_quizzes.find_one({"id": out["quiz_id"]}))
    assert fresh["content_hash"] == coaching._impact_quiz_hash(impact)
    # Cached doc keeps the answers server-side
    assert all("answer" in q for q in fresh["questions"])


def test_hash_changes_when_body_changes():
    a = _impact()
    b = _impact(body=IMPACT_BODY + " New paragraph added by an admin edit.")
    assert coaching._impact_quiz_hash(a) != coaching._impact_quiz_hash(b)


# ── 404-unavailable paths ─────────────────────────────────────────────────

def test_404_when_generation_unavailable_no_api_key(monkeypatch):
    db = _db()
    _run(db.coaching_impacts.insert_one(dict(_impact())))
    _patch_coaching(monkeypatch, db, LEADER)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("EMERGENT_LLM_KEY", raising=False)

    with pytest.raises(HTTPException) as exc:
        _run(coaching.get_impact_quiz("imp-1", request=None))
    assert exc.value.status_code == 404
    assert _run(db.coaching_impact_quizzes.count_documents({})) == 0


def test_404_when_content_too_short_even_if_llm_available(monkeypatch):
    db = _db()
    _run(db.coaching_impacts.insert_one(dict(_impact(body="Short.", summary=""))))
    _patch_coaching(monkeypatch, db, LEADER)
    _forbid_generation(monkeypatch)  # must short-circuit before the LLM

    with pytest.raises(HTTPException) as exc:
        _run(coaching.get_impact_quiz("imp-1", request=None))
    assert exc.value.status_code == 404


def test_404_when_impact_missing(monkeypatch):
    db = _db()
    _patch_coaching(monkeypatch, db, ADMIN)
    with pytest.raises(HTTPException) as exc:
        _run(coaching.get_impact_quiz("nope", request=None))
    assert exc.value.status_code == 404


def test_submit_stale_quiz_id_404(monkeypatch):
    db = _db()
    _run(db.coaching_impacts.insert_one(dict(_impact())))
    _patch_coaching(monkeypatch, db, LEADER)
    with pytest.raises(HTTPException) as exc:
        _run(coaching.submit_impact_quiz(
            "imp-1", ImpactQuizSubmit(quiz_id="gone", answers={}), request=None))
    assert exc.value.status_code == 404


# ── Audience / stage scoping ──────────────────────────────────────────────

def test_leader_cannot_quiz_stage4_impact(monkeypatch):
    db = _db()
    impact = _impact(stage=4)
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, LEADER)

    with pytest.raises(HTTPException) as exc:
        _run(coaching.get_impact_quiz("imp-1", request=None))
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc:
        _run(coaching.submit_impact_quiz(
            "imp-1", ImpactQuizSubmit(quiz_id="quiz-1", answers=ANSWERS_3_OF_3), request=None))
    assert exc.value.status_code == 403
    assert _run(db.coaching_impact_quiz_passes.count_documents({})) == 0


def test_core_leader_and_admin_can_quiz_stage4(monkeypatch):
    db = _db()
    impact = _impact(stage=4)
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _forbid_generation(monkeypatch)
    for user in (CORE_LEADER, ADMIN):
        _patch_coaching(monkeypatch, db, user)
        out = _run(coaching.get_impact_quiz("imp-1", request=None))
        assert out["quiz_id"] == "quiz-1"


def test_trainee_cannot_quiz_stage3_impact(monkeypatch):
    db = _db()
    impact = _impact(stage=3)
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, TRAINEE)
    # _impact_stages_for_user consults routes.modules._is_stage_unlocked
    monkeypatch.setattr(modules, "db", db)

    with pytest.raises(HTTPException) as exc:
        _run(coaching.get_impact_quiz("imp-1", request=None))
    assert exc.value.status_code == 403


def test_trainee_with_stage2_unlocked_can_quiz_stage2(monkeypatch):
    db = _db()
    impact = _impact(stage=2)
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    for day in range(1, 9):
        _run(db.daily_assessments.insert_one(
            {"new_hire_id": "hire-1", "day_number": day, "completed": True}))
    _patch_coaching(monkeypatch, db, TRAINEE)
    monkeypatch.setattr(modules, "db", db)
    _forbid_generation(monkeypatch)

    out = _run(coaching.get_impact_quiz("imp-1", request=None))
    assert out["quiz_id"] == "quiz-1"


def test_trainee_without_stage2_locked_out_of_stage2(monkeypatch):
    db = _db()
    impact = _impact(stage=2)
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, TRAINEE)
    monkeypatch.setattr(modules, "db", db)  # no completed days seeded

    with pytest.raises(HTTPException) as exc:
        _run(coaching.get_impact_quiz("imp-1", request=None))
    assert exc.value.status_code == 403


# ── Grading + pass persistence ────────────────────────────────────────────

def test_submit_grades_and_persists_pass(monkeypatch):
    db = _db()
    impact = _impact()
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, LEADER)

    out = _run(coaching.submit_impact_quiz(
        "imp-1", ImpactQuizSubmit(quiz_id="quiz-1", answers=ANSWERS_2_OF_3), request=None))
    assert out["score"] == 2 and out["total"] == 3 and out["passed"] is True
    by_id = {r["id"]: r for r in out["results"]}
    assert by_id["q0"]["ok"] is True and by_id["q2"]["ok"] is False
    assert by_id["q2"]["correct"] == 2 and by_id["q2"]["chosen"] == 0

    row = _run(db.coaching_impact_quiz_passes.find_one({"user_id": "u-leader", "impact_id": "imp-1"}))
    assert row["score"] == 2 and row["total"] == 3
    assert row["passed"] is True and row["passed_at"]


def test_one_of_three_fails(monkeypatch):
    db = _db()
    impact = _impact()
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, LEADER)

    out = _run(coaching.submit_impact_quiz(
        "imp-1", ImpactQuizSubmit(quiz_id="quiz-1", answers={"q0": 0, "q1": 3, "q2": 0}), request=None))
    assert out["score"] == 1 and out["passed"] is False
    row = _run(db.coaching_impact_quiz_passes.find_one({"user_id": "u-leader"}))
    assert row["passed"] is False and row["passed_at"] is None


def test_reattempt_upserts_best_score_and_pass_is_sticky(monkeypatch):
    db = _db()
    impact = _impact()
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, LEADER)

    _run(coaching.submit_impact_quiz(
        "imp-1", ImpactQuizSubmit(quiz_id="quiz-1", answers=ANSWERS_2_OF_3), request=None))
    first = _run(db.coaching_impact_quiz_passes.find_one({"user_id": "u-leader"}))

    # A worse re-attempt must not downgrade score or pass
    _run(coaching.submit_impact_quiz(
        "imp-1", ImpactQuizSubmit(quiz_id="quiz-1", answers=ANSWERS_0_OF_3), request=None))
    row = _run(db.coaching_impact_quiz_passes.find_one({"user_id": "u-leader"}))
    assert row["score"] == 2 and row["passed"] is True
    assert row["passed_at"] == first["passed_at"]

    # A better re-attempt upgrades the score
    _run(coaching.submit_impact_quiz(
        "imp-1", ImpactQuizSubmit(quiz_id="quiz-1", answers=ANSWERS_3_OF_3), request=None))
    row = _run(db.coaching_impact_quiz_passes.find_one({"user_id": "u-leader"}))
    assert row["score"] == 3 and row["passed"] is True
    # One row per (user, impact) — it's an upsert, not an attempt log
    assert _run(db.coaching_impact_quiz_passes.count_documents({})) == 1


# ── quiz-state ────────────────────────────────────────────────────────────

def test_quiz_state_before_and_after_pass(monkeypatch):
    db = _db()
    impact = _impact()
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, LEADER)

    state = _run(coaching.get_impact_quiz_state("imp-1", request=None))
    assert state == {"passed": False, "score": None, "total": None, "passed_at": None}

    _run(coaching.submit_impact_quiz(
        "imp-1", ImpactQuizSubmit(quiz_id="quiz-1", answers=ANSWERS_2_OF_3), request=None))
    state = _run(coaching.get_impact_quiz_state("imp-1", request=None))
    assert state["passed"] is True and state["score"] == 2 and state["total"] == 3
    assert state["passed_at"]
    assert set(state.keys()) == {"passed", "score", "total", "passed_at"}


def test_quiz_state_is_per_user(monkeypatch):
    db = _db()
    impact = _impact()
    _run(db.coaching_impacts.insert_one(dict(impact)))
    _seed_cached_impact_quiz(db, impact)
    _patch_coaching(monkeypatch, db, LEADER)
    _run(coaching.submit_impact_quiz(
        "imp-1", ImpactQuizSubmit(quiz_id="quiz-1", answers=ANSWERS_3_OF_3), request=None))

    _patch_coaching(monkeypatch, db, CORE_LEADER)
    state = _run(coaching.get_impact_quiz_state("imp-1", request=None))
    assert state["passed"] is False and state["score"] is None
