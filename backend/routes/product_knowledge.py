"""Product Knowledge — self-serve micro-training on the campaign/product.

Available to every role from day one. Provides:
    • A knowledge base of product/campaign topics (admin-editable via the
      /product-knowledge/topics endpoints, or bundled as
      backend/seed/product_knowledge_topics.json for first boot)
    • A multiple-choice / true-false exam bank (admin-editable via
      /product-knowledge/questions, or backend/seed/product_exam_questions.json)
    • Trainee exam attempts: start → submit → leader/admin pass-off
    • Leader/admin views the latest attempt + manual pass-off button

Topics ship with the campaign playbook (seeded into an empty collection on
first boot); the exam bank starts EMPTY and the exam shows its not-set-up
state until an admin adds questions.

Pass-off rights: office admin OR the trainee's direct leader (reports_to chain).
"""
from __future__ import annotations

import random
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from bson import ObjectId
from bson.errors import InvalidId

from auth import get_current_user
from database import db
from core.achievements import award

router = APIRouter()


# ──────────────────────── Helpers ─────────────────────────────────────────


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _get_user_by_id(uid: Optional[str]) -> Optional[dict]:
    """Resolve a user document by the string form of their _id."""
    if not uid:
        return None
    try:
        oid = ObjectId(uid)
    except (InvalidId, TypeError, ValueError):
        return None
    return await db.users.find_one({"_id": oid})


def _is_admin(user: dict) -> bool:
    return (user.get("role") or "").lower() == "admin"


async def _trainee_day2_passed(user: dict) -> bool:
    """True if Day 2 of orientation has been completed (trainee submitted)."""
    hire_id = user.get("new_hire_id")
    if not hire_id:
        return False
    doc = await db.daily_assessments.find_one(
        {"new_hire_id": hire_id, "day_number": 2, "completed": True}
    )
    return bool(doc)


async def _can_user_see_pk(user: dict) -> bool:
    # Open to all roles from day one — product training shouldn't wait for
    # orientation pass-offs. (Day-2 gate removed 2026-07; the helper above
    # is still used by /status so the UI can show orientation progress.)
    return True


# ──────────────────────── Region scoping ──────────────────────────────────
# Optional. Topics and exam questions may carry a `regions` list (any labels
# you like, e.g. ["north"], ["all"]); an office opts into a region by having
# a `region` field on its offices document. Content with NO `regions` field,
# or tagged "all", is visible everywhere. An office with no `region` sees
# only that shared content, never another region's.

DEFAULT_REGION = "all"


def _office_region(office: dict | None) -> str:
    return str((office or {}).get("region") or "").strip() or DEFAULT_REGION


async def _user_region(user: dict) -> str:
    office_id = user.get("office_id")
    if not office_id:
        return DEFAULT_REGION
    office = await db.offices.find_one({"id": office_id}, {"region": 1})
    return _office_region(office)


def _region_filter(region: str) -> dict:
    """Mongo filter: docs whose regions include this region or 'all', plus
    docs with no regions field at all (legacy == visible everywhere)."""
    return {"$or": [
        {"regions": {"$exists": False}},
        {"regions": {"$in": [region, "all"]}},
    ]}


async def _can_pass_off(actor: dict, trainee: dict) -> bool:
    """Office admin (same office) OR direct/upstream leader of the trainee."""
    if _is_admin(actor):
        # Same office only (super admin always allowed)
        if actor.get("is_super_admin"):
            return True
        return (actor.get("office_id") and
                actor.get("office_id") == trainee.get("office_id"))
    if (actor.get("role") or "").lower() != "leader":
        return False
    # Walk up trainee's reports_to chain to see if actor is in it
    cursor_id = trainee.get("reports_to")
    visited = set()
    for _ in range(10):
        if not cursor_id or cursor_id in visited:
            break
        visited.add(cursor_id)
        if cursor_id == actor.get("id"):
            return True
        parent = await _get_user_by_id(cursor_id)
        if parent:
            cursor_id = parent.get("reports_to")
        else:
            cursor_id = None
    return False


# ──────────────────────── Serializers ─────────────────────────────────────


def _ser_topic(d: dict) -> dict:
    return {
        "id": d.get("id"),
        "slug": d.get("slug"),
        "title": d.get("title"),
        "category": d.get("category"),
        "summary": d.get("summary"),
        "body": d.get("body"),
        "key_facts": list(d.get("key_facts") or []),
        "source_url": d.get("source_url") or "",
        "order": int(d.get("order") or 0),
        "regions": list(d.get("regions") or ["all"]),
    }


def _ser_question(q: dict, include_answer: bool) -> dict:
    out = {
        "id": q.get("id"),
        "topic_id": q.get("topic_id"),
        "topic_slug": q.get("topic_slug"),
        "kind": q.get("kind") or "mc",
        "question": q.get("question") or "",
        "choices": list(q.get("choices") or []),
    }
    if q.get("kind") == "tf":
        # Make TF look like MC for the UI
        out["choices"] = ["True", "False"]
    if include_answer:
        out["correct_index"] = q.get("correct_index")
        out["answer"] = q.get("answer")
        out["explanation"] = q.get("explanation") or ""
        out["regions"] = list(q.get("regions") or ["all"])
    return out


def _ser_attempt(a: dict, include_questions: bool = False) -> dict:
    out = {
        "id": a.get("id"),
        "user_id": a.get("user_id"),
        "started_at": a.get("started_at"),
        "submitted_at": a.get("submitted_at"),
        "score_pct": a.get("score_pct"),
        "score_correct": a.get("score_correct"),
        "score_total": a.get("score_total"),
        "passed_off": bool(a.get("passed_off")),
        "passed_off_at": a.get("passed_off_at"),
        "passed_off_by_id": a.get("passed_off_by_id"),
        "passed_off_by_name": a.get("passed_off_by_name"),
    }
    if include_questions:
        out["question_ids"] = list(a.get("question_ids") or [])
        out["answers"] = list(a.get("answers") or [])
    return out


# ──────────────────────── Status ──────────────────────────────────────────


@router.get("/product-knowledge/status")
async def status(request: Request):
    user = await get_current_user(request)
    role = (user.get("role") or "").lower()
    is_visible = await _can_user_see_pk(user)
    day2_passed = await _trainee_day2_passed(user) if role == "trainee" else None
    # Latest **submitted** attempt by this user (skip in-progress / unsubmitted
    # ones so the trainee progress card flips to "Completed" right after they
    # finish, instead of getting stuck on a stale started-but-abandoned doc).
    latest = await db.product_exam_attempts.find_one(
        {"user_id": user.get("id"), "submitted_at": {"$ne": None}},
        sort=[("submitted_at", -1)],
    )
    return {
        "is_visible": is_visible,
        "is_admin": _is_admin(user),
        "is_trainee": role == "trainee",
        "day2_passed": day2_passed,
        "latest_attempt": _ser_attempt(latest) if latest else None,
        "topic_count": await db.product_knowledge_topics.count_documents({}),
        "question_count": await db.product_exam_questions.count_documents({}),
    }


# ──────────────────────── Topics — read ───────────────────────────────────


@router.get("/product-knowledge/topics")
async def list_topics(request: Request):
    user = await get_current_user(request)
    if not await _can_user_see_pk(user):
        raise HTTPException(status_code=403, detail="Product knowledge is unavailable.")
    # Admins see the full library (they manage it); everyone else only sees
    # topics for their office's region (+ "all" + untagged legacy).
    query = {} if _is_admin(user) else _region_filter(await _user_region(user))
    out: List[dict] = []
    async for d in db.product_knowledge_topics.find(query).sort([("order", 1), ("title", 1)]):
        out.append(_ser_topic(d))
    return {"topics": out}


# ──────────────────────── Topics — admin CRUD ─────────────────────────────


class TopicBody(BaseModel):
    slug: Optional[str] = None
    title: str
    category: str = "general"
    summary: str = ""
    body: str = ""
    key_facts: List[str] = Field(default_factory=list)
    source_url: str = ""
    order: int = 0
    regions: Optional[List[str]] = None  # e.g. ["north"], ["all"]


@router.post("/product-knowledge/topics")
async def create_topic(body: TopicBody, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title required")
    doc = {
        "id": str(uuid.uuid4()),
        "slug": (body.slug or "").strip() or title.lower().replace(" ", "-")[:80],
        "title": title,
        "category": (body.category or "general").lower(),
        "summary": body.summary.strip(),
        "body": body.body.strip(),
        "key_facts": [s.strip() for s in body.key_facts if s and s.strip()],
        "source_url": body.source_url.strip(),
        "order": int(body.order or 0),
        "regions": [s.strip() for s in (body.regions or []) if s and s.strip()] or ["all"],
        "created_at": _now(),
        "updated_at": _now(),
    }
    await db.product_knowledge_topics.insert_one(doc)
    return _ser_topic(doc)


@router.put("/product-knowledge/topics/{topic_id}")
async def update_topic(topic_id: str, body: TopicBody, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    set_doc = {
        "title": body.title.strip(),
        "category": (body.category or "general").lower(),
        "summary": body.summary.strip(),
        "body": body.body.strip(),
        "key_facts": [s.strip() for s in body.key_facts if s and s.strip()],
        "source_url": body.source_url.strip(),
        "order": int(body.order or 0),
        "updated_at": _now(),
    }
    if body.slug:
        set_doc["slug"] = body.slug.strip()
    if body.regions is not None:
        set_doc["regions"] = [s.strip() for s in body.regions if s and s.strip()] or ["all"]
    res = await db.product_knowledge_topics.update_one({"id": topic_id}, {"$set": set_doc})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Topic not found")
    d = await db.product_knowledge_topics.find_one({"id": topic_id})
    return _ser_topic(d)


@router.delete("/product-knowledge/topics/{topic_id}")
async def delete_topic(topic_id: str, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    res = await db.product_knowledge_topics.delete_one({"id": topic_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Topic not found")
    return {"ok": True}


# ──────────────────────── Questions — admin CRUD ──────────────────────────


class QuestionBody(BaseModel):
    topic_slug: Optional[str] = None
    topic_id: Optional[str] = None
    kind: str = "mc"  # 'mc' or 'tf'
    question: str
    choices: List[str] = Field(default_factory=list)
    correct_index: Optional[int] = None
    answer: Optional[bool] = None
    explanation: str = ""
    regions: Optional[List[str]] = None  # e.g. ["north"], ["all"]


@router.get("/product-knowledge/questions")
async def list_questions(request: Request):
    """Admin-only — full question bank with answers."""
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    out: List[dict] = []
    async for q in db.product_exam_questions.find({}).sort([("topic_slug", 1)]):
        out.append(_ser_question(q, include_answer=True))
    return {"questions": out}


@router.post("/product-knowledge/questions")
async def create_question(body: QuestionBody, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    if body.kind not in ("mc", "tf"):
        raise HTTPException(status_code=400, detail="kind must be 'mc' or 'tf'")
    if not (body.question or "").strip():
        raise HTTPException(status_code=400, detail="Question text required")
    if body.kind == "mc":
        if not body.choices or len(body.choices) < 2:
            raise HTTPException(status_code=400, detail="MC needs ≥2 choices")
        if body.correct_index is None or body.correct_index < 0 or body.correct_index >= len(body.choices):
            raise HTTPException(status_code=400, detail="correct_index out of range")
    else:
        if body.answer is None:
            raise HTTPException(status_code=400, detail="TF needs answer (true/false)")
    # Resolve topic
    topic = None
    if body.topic_id:
        topic = await db.product_knowledge_topics.find_one({"id": body.topic_id})
    elif body.topic_slug:
        topic = await db.product_knowledge_topics.find_one({"slug": body.topic_slug})
    doc = {
        "id": str(uuid.uuid4()),
        "topic_id": (topic or {}).get("id"),
        "topic_slug": (topic or {}).get("slug") or body.topic_slug,
        "kind": body.kind,
        "question": body.question.strip(),
        "choices": list(body.choices) if body.kind == "mc" else [],
        "correct_index": body.correct_index if body.kind == "mc" else None,
        "answer": body.answer if body.kind == "tf" else None,
        "explanation": body.explanation.strip(),
        "regions": [s.strip() for s in (body.regions or []) if s and s.strip()] or ["all"],
        "created_at": _now(),
        "updated_at": _now(),
    }
    await db.product_exam_questions.insert_one(doc)
    return _ser_question(doc, include_answer=True)


@router.put("/product-knowledge/questions/{qid}")
async def update_question(qid: str, body: QuestionBody, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    set_doc = {
        "kind": body.kind,
        "question": body.question.strip(),
        "choices": list(body.choices) if body.kind == "mc" else [],
        "correct_index": body.correct_index if body.kind == "mc" else None,
        "answer": body.answer if body.kind == "tf" else None,
        "explanation": body.explanation.strip(),
        "updated_at": _now(),
    }
    if body.regions is not None:
        set_doc["regions"] = [s.strip() for s in body.regions if s and s.strip()] or ["all"]
    if body.topic_slug or body.topic_id:
        topic = None
        if body.topic_id:
            topic = await db.product_knowledge_topics.find_one({"id": body.topic_id})
        elif body.topic_slug:
            topic = await db.product_knowledge_topics.find_one({"slug": body.topic_slug})
        if topic:
            set_doc["topic_id"] = topic.get("id")
            set_doc["topic_slug"] = topic.get("slug")
    res = await db.product_exam_questions.update_one({"id": qid}, {"$set": set_doc})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Question not found")
    q = await db.product_exam_questions.find_one({"id": qid})
    return _ser_question(q, include_answer=True)


@router.delete("/product-knowledge/questions/{qid}")
async def delete_question(qid: str, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    res = await db.product_exam_questions.delete_one({"id": qid})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Question not found")
    return {"ok": True}


# ──────────────────────── Exam ─────────────────────────────────────────────

EXAM_LENGTH = 12  # questions per attempt


class ExamSubmitBody(BaseModel):
    answers: List[dict]  # [{ question_id, response: int|bool }]


@router.post("/product-knowledge/exam/start")
async def start_exam(request: Request):
    user = await get_current_user(request)
    if not await _can_user_see_pk(user):
        raise HTTPException(status_code=403, detail="The exam is unavailable.")
    # Region-scope the pool: questions tagged for another region never reach
    # this office's exam. Questions with no `regions` field count as ["all"].
    pool: List[dict] = []
    async for q in db.product_exam_questions.find(_region_filter(await _user_region(user))):
        pool.append(q)
    if len(pool) < 4:
        raise HTTPException(status_code=503, detail="Not enough questions seeded yet.")
    random.shuffle(pool)
    selected = pool[: min(EXAM_LENGTH, len(pool))]
    attempt = {
        "id": str(uuid.uuid4()),
        "user_id": user.get("id"),
        "started_at": _now(),
        "submitted_at": None,
        "question_ids": [q["id"] for q in selected],
        "answers": [],
        "score_pct": None,
        "score_correct": None,
        "score_total": len(selected),
        "passed_off": False,
    }
    await db.product_exam_attempts.insert_one(attempt)
    return {
        "attempt_id": attempt["id"],
        "questions": [_ser_question(q, include_answer=False) for q in selected],
        "total": len(selected),
    }


@router.post("/product-knowledge/exam/{attempt_id}/submit")
async def submit_exam(attempt_id: str, body: ExamSubmitBody, request: Request):
    user = await get_current_user(request)
    a = await db.product_exam_attempts.find_one({"id": attempt_id, "user_id": user.get("id")})
    if not a:
        raise HTTPException(status_code=404, detail="Attempt not found")
    if a.get("submitted_at"):
        raise HTTPException(status_code=400, detail="Already submitted")
    # Build map of question_id → correct
    qs: List[dict] = []
    async for q in db.product_exam_questions.find({"id": {"$in": list(a.get("question_ids") or [])}}):
        qs.append(q)
    qmap = {q["id"]: q for q in qs}
    # Score
    # One response per assigned question. Previously duplicate entries in the
    # client list could increment `correct` repeatedly for the same question,
    # allowing a forged perfect score and achievement.
    responses: dict = {}
    for ans in body.answers or []:
        qid = ans.get("question_id")
        if qid in qmap and qid not in responses:
            responses[qid] = ans.get("response")

    graded: List[dict] = []
    correct = 0
    for qid in list(a.get("question_ids") or []):
        q = qmap.get(qid)
        if not q:
            continue
        is_correct = False
        response = responses.get(qid)
        if q.get("kind") == "mc":
            try:
                is_correct = int(response) == int(q.get("correct_index"))
            except Exception:
                is_correct = False
        elif q.get("kind") == "tf":
            is_correct = bool(response) == bool(q.get("answer"))
        if is_correct:
            correct += 1
        graded.append({
            "question_id": qid,
            "topic_slug": q.get("topic_slug"),
            "question": q.get("question"),
            "kind": q.get("kind"),
            "response": response,
            "correct": is_correct,
            "correct_index": q.get("correct_index"),
            "correct_answer": q.get("answer"),
            "explanation": q.get("explanation") or "",
            "choices": list(q.get("choices") or []),
        })
    total = int(a.get("score_total") or len(qs))
    score_pct = round((correct / total) * 100) if total else 0
    await db.product_exam_attempts.update_one(
        {"id": attempt_id},
        {"$set": {
            "submitted_at": _now(),
            "answers": graded,
            "score_correct": correct,
            "score_total": total,
            "score_pct": score_pct,
        }},
    )
    if score_pct >= 90:
        try:
            await award(user.get("id"), "exam_90")
        except Exception:
            pass
    return {
        "attempt_id": attempt_id,
        "score_correct": correct,
        "score_total": total,
        "score_pct": score_pct,
        "answers": graded,
    }


@router.get("/product-knowledge/exam/my-attempts")
async def my_attempts(request: Request):
    user = await get_current_user(request)
    items: List[dict] = []
    async for a in db.product_exam_attempts.find({"user_id": user.get("id")}).sort([("started_at", -1)]):
        items.append(_ser_attempt(a))
    return {"attempts": items}


@router.get("/product-knowledge/exam/attempts/{attempt_id}")
async def get_attempt(attempt_id: str, request: Request):
    user = await get_current_user(request)
    a = await db.product_exam_attempts.find_one({"id": attempt_id})
    if not a:
        raise HTTPException(status_code=404, detail="Attempt not found")
    # Ownership: self, or admin/leader who can pass off
    if a.get("user_id") != user.get("id"):
        owner = await _get_user_by_id(a.get("user_id"))
        if not owner or not await _can_pass_off(user, owner):
            raise HTTPException(status_code=403, detail="Not authorised")
    return _ser_attempt(a, include_questions=True)


# ──────────────────────── Leader/Admin pass-off ───────────────────────────


@router.get("/leader/trainees/{trainee_id}/product-exam")
async def trainee_latest_attempt(trainee_id: str, request: Request):
    actor = await get_current_user(request)
    trainee = await _get_user_by_id(trainee_id)
    if not trainee:
        raise HTTPException(status_code=404, detail="BA not found")
    if not await _can_pass_off(actor, trainee):
        raise HTTPException(status_code=403, detail="Not authorised to view this BA")
    latest = await db.product_exam_attempts.find_one(
        {"user_id": trainee_id},
        sort=[("submitted_at", -1)],
    )
    history: List[dict] = []
    async for a in db.product_exam_attempts.find({"user_id": trainee_id}).sort([("started_at", -1)]).limit(10):
        history.append(_ser_attempt(a))
    return {
        "trainee_id": trainee_id,
        "latest": _ser_attempt(latest, include_questions=True) if latest else None,
        "history": history,
    }


class PassOffBody(BaseModel):
    pass_off: bool = True


@router.post("/leader/trainees/{trainee_id}/product-exam/pass-off")
async def pass_off(trainee_id: str, body: PassOffBody, request: Request):
    actor = await get_current_user(request)
    trainee = await _get_user_by_id(trainee_id)
    if not trainee:
        raise HTTPException(status_code=404, detail="BA not found")
    if not await _can_pass_off(actor, trainee):
        raise HTTPException(status_code=403, detail="Not authorised to pass off this BA")
    latest = await db.product_exam_attempts.find_one(
        {"user_id": trainee_id, "submitted_at": {"$ne": None}},
        sort=[("submitted_at", -1)],
    )
    if not latest:
        raise HTTPException(status_code=400, detail="This BA has not yet submitted an exam")
    set_doc = {
        "passed_off": bool(body.pass_off),
        "passed_off_at": _now() if body.pass_off else None,
        "passed_off_by_id": actor.get("id") if body.pass_off else None,
        "passed_off_by_name": actor.get("name") if body.pass_off else None,
    }
    await db.product_exam_attempts.update_one({"id": latest["id"]}, {"$set": set_doc})
    a = await db.product_exam_attempts.find_one({"id": latest["id"]})
    return _ser_attempt(a)
