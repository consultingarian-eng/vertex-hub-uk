"""Leadership Hub — AI Coaching Assistant.

A small RAG-style assistant over the `coaching_impacts` collection. Leaders
and admins (plus trainees, bounded to their unlocked stages) can ask
"how do I teach the objection cycle?" / "I'm struggling with closing — what
should I run tomorrow?" and get a coaching-style answer grounded in the
exact same impacts they're already studying in the Hub.

Pipeline:
    1. Pull the user's accessible impacts (re-uses _impact_stages_for_user).
    2. Score impacts vs the question with a simple lexical match
       (title/summary/body/key_takeaways) — fast, deterministic, free.
    3. Take the top N (default 6) and format as compact context snippets.
    4. Call Anthropic Claude Sonnet 4.5 via emergentintegrations LlmChat,
       passing the prior conversation history + system prompt + question
       prefixed with the snippets.
    5. Persist the conversation in `coaching_assistant_conversations`.

Persistence schema (Mongo):
    coaching_assistant_conversations:
        { id, user_id, title, created_at, updated_at,
          messages: [ { role: "user"|"assistant", text, citations: [impact_id], at } ] }
"""
from __future__ import annotations

import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from dotenv import load_dotenv
load_dotenv()

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user
from core.brand import BRITISH_ENGLISH, SELF_EMPLOYED_TERMS
from core.llm_guard import acquire_llm_slot
from database import db
from core.rate_limit import take_ai_quota
from routes.coaching import _impact_stages_for_user, _serialize_impact

logger = logging.getLogger(__name__)
router = APIRouter()


# ──────────────────────── Models ──────────────────────────────────────────

class AskRequest(BaseModel):
    conversation_id: Optional[str] = None
    message: str = Field(..., min_length=1, max_length=2000)


class ConversationStub(BaseModel):
    id: str
    title: str
    updated_at: str
    message_count: int


# ──────────────────────── Helpers ─────────────────────────────────────────


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> set[str]:
    return {t for t in _TOKEN_RE.findall((text or "").lower()) if len(t) >= 3}


# Common English stop-words we should ignore when scoring relevance.
_STOP = {
    "the", "and", "for", "with", "that", "this", "from", "have", "has",
    "are", "was", "were", "they", "their", "them", "you", "your", "our",
    "what", "when", "where", "which", "while", "should", "could", "would",
    "about", "into", "than", "then", "there", "these", "those", "much",
    "many", "very", "just", "some", "more", "less", "also", "such", "make",
    "made", "want", "wants", "need", "needs", "best", "good", "great",
    "help", "tell", "show", "give", "person", "people", "trainee", "rep",
    "doing", "does", "going", "tips", "way", "ways", "how", "why", "who",
    "out", "over", "off", "use", "using", "uses", "tomorrow", "today",
}


async def _retrieve_impacts(user: dict, question: str, k: int = 6) -> List[dict]:
    """Pull impacts visible to the user, score by lexical overlap, return top-k."""
    stages = await _impact_stages_for_user(user)
    if not stages:
        return []
    q_tokens = _tokens(question) - _STOP
    if not q_tokens:
        return []
    scored: list[tuple[int, dict]] = []
    async for d in db.coaching_impacts.find({"stage": {"$in": stages}}):
        title_t = _tokens(d.get("title") or "")
        summary_t = _tokens(d.get("summary") or "")
        body_t = _tokens(d.get("body") or "")
        kt_t = _tokens(" ".join(d.get("key_takeaways") or []))
        cat_t = _tokens(d.get("category") or "")
        # Weighted score
        score = (
            5 * len(q_tokens & title_t)
            + 3 * len(q_tokens & summary_t)
            + 2 * len(q_tokens & kt_t)
            + 2 * len(q_tokens & cat_t)
            + 1 * len(q_tokens & body_t)
        )
        if score > 0:
            scored.append((score, d))
    scored.sort(key=lambda r: (-r[0], int(r[1].get("stage") or 0), r[1].get("title") or ""))
    return [d for _, d in scored[:k]]


def _format_snippet(d: dict) -> str:
    title = d.get("title") or "Untitled"
    stage = d.get("stage") or "?"
    summary = (d.get("summary") or "").strip()
    body = (d.get("body") or "").strip()
    takeaways = d.get("key_takeaways") or []
    src = d.get("source") or ""
    parts = [f"### Impact: {title}  (Stage {stage}, source: {src})"]
    if summary:
        parts.append(f"Summary: {summary}")
    if takeaways:
        parts.append("Key takeaways:\n- " + "\n- ".join(takeaways))
    if body:
        # Cap to 800 chars per impact to keep the prompt lean
        b = body if len(body) <= 800 else body[:800] + "…"
        parts.append(f"Content:\n{b}")
    return "\n".join(parts)


SYSTEM_PROMPT = """You are the **Leadership Hub Coaching Assistant** for a network of self-employed Brand Ambassadors (BAs) who fundraise door to door.

Your role is to help coaches and BAs coach more effectively. You ground EVERY answer in the impacts (coaching topics) that the user has access to — these are passages from the office's Impact Booklet and Leadership Development Toolkit.

Hard rules:
1.  ONLY use the impacts in the context I send you as the source of truth. If an impact is not in the context, you may NOT mention it. If the question is outside the available content, say "That isn't covered in your current Leadership Hub yet — try looking in the Library tab or ask your office admin to add an impact about it."
2.  Quote impact TITLES exactly when you reference them (e.g. **"Objection Cycle"**) so the user can find it in the Hub. Use bold markdown.
3.  Be concise, direct, coach-tone — like an experienced coach giving practical, in-the-moment advice. NO fluff. NO long disclaimers. NO bullet-point dumps that just regurgitate the impact.
4.  Structure: a) brief framing of the situation, b) 2-4 specific actions/scripts/role-play steps the coach can use TODAY, c) which impact(s) to run with the BA tomorrow morning. Use short paragraphs and small bullet lists, not walls of text.
5.  Always end with a one-line "📚 Suggested impacts: …" naming the impact titles you drew from.
6.  If the question is vague, ask ONE clarifying question rather than guessing.
7.  No emojis except the single 📚 line. No corporate speak.
8.  """ + BRITISH_ENGLISH + "\n9.  " + SELF_EMPLOYED_TERMS + "\n"


def _build_user_prompt(question: str, snippets: List[dict]) -> str:
    """Compose the user-facing prompt with retrieved context."""
    if not snippets:
        return (
            "(No impacts matched the user's question via lexical search. "
            "If the question is general (a greeting / clarification), respond conversationally. "
            "Otherwise, gently say the topic isn't in their Hub yet.)\n\n"
            f"User question: {question}"
        )
    ctx = "\n\n---\n\n".join(_format_snippet(d) for d in snippets)
    return (
        "Context (the impacts visible to this user):\n\n"
        f"{ctx}\n\n---\n\n"
        f"User question: {question}"
    )


def _serialize_msg(m: dict) -> dict:
    return {
        "role": m.get("role"),
        "text": m.get("text") or "",
        "citations": list(m.get("citations") or []),
        "at": m.get("at"),
    }


def _serialize_conv(c: dict, include_messages: bool = False) -> dict:
    out = {
        "id": c.get("id"),
        "title": c.get("title") or "Untitled",
        "created_at": c.get("created_at"),
        "updated_at": c.get("updated_at"),
        "message_count": len(c.get("messages") or []),
    }
    if include_messages:
        out["messages"] = [_serialize_msg(m) for m in (c.get("messages") or [])]
    return out


# ──────────────────────── Endpoints ───────────────────────────────────────


@router.get("/coaching/assistant/conversations")
async def list_conversations(request: Request):
    user = await get_current_user(request)
    items: List[dict] = []
    cursor = db.coaching_assistant_conversations.find(
        {"user_id": user.get("id")}
    ).sort([("updated_at", -1)]).limit(40)
    async for c in cursor:
        items.append(_serialize_conv(c))
    return {"conversations": items}


@router.get("/coaching/assistant/conversations/{conv_id}")
async def get_conversation(conv_id: str, request: Request):
    user = await get_current_user(request)
    c = await db.coaching_assistant_conversations.find_one(
        {"id": conv_id, "user_id": user.get("id")}
    )
    if not c:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _serialize_conv(c, include_messages=True)


@router.delete("/coaching/assistant/conversations/{conv_id}")
async def delete_conversation(conv_id: str, request: Request):
    user = await get_current_user(request)
    res = await db.coaching_assistant_conversations.delete_one(
        {"id": conv_id, "user_id": user.get("id")}
    )
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"ok": True}


@router.post("/coaching/assistant/ask")
async def ask(req: AskRequest, request: Request):
    user = await get_current_user(request)
    user_id = user.get("id")
    question = (req.message or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Message is required")
    take_ai_quota(user)  # per-person hourly AI cap (core/rate_limit.py)

    # Load or create conversation
    conv: Optional[dict] = None
    if req.conversation_id:
        conv = await db.coaching_assistant_conversations.find_one(
            {"id": req.conversation_id, "user_id": user_id}
        )
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")
    if conv is None:
        conv = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "title": question[:60] + ("…" if len(question) > 60 else ""),
            "messages": [],
            "created_at": _now(),
            "updated_at": _now(),
        }
        await db.coaching_assistant_conversations.insert_one(conv)

    history = list(conv.get("messages") or [])

    # Retrieve top-k impacts
    snippets = await _retrieve_impacts(user, question, k=6)
    citation_ids = [s.get("id") for s in snippets if s.get("id")]

    # Build LLM
    from core.llm_keys import anthropic_api_key
    api_key = anthropic_api_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="LLM key not configured")

    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM library unavailable: {e}") from e

    chat = LlmChat(
        api_key=api_key,
        session_id=conv["id"],
        system_message=SYSTEM_PROMPT,
    ).with_model("anthropic")

    user_prompt = _build_user_prompt(question, snippets)

    # Concurrency guard — the replay turns below are real model calls too, so
    # ONE slot covers the whole replay + live turn (releasing between turns
    # would let a classroom interleave half-replayed conversations past the
    # cap). Mongo reads above and the persist below stay outside the slot.
    async with acquire_llm_slot():
        # Replay prior history so the assistant has context. We send each turn as a
        # UserMessage so the library can build the multi-turn conversation. The
        # library tracks history per session_id internally; we still replay because
        # the FastAPI process may have been restarted between requests.
        for m in history:
            if not m.get("text"):
                continue
            if m.get("role") == "user":
                try:
                    await chat.send_message(UserMessage(text=m["text"]))
                except Exception:
                    pass  # best-effort replay; failures here aren't fatal
            # Assistant responses are reconstructed implicitly by the library on send.

        try:
            response_text: str = await chat.send_message(UserMessage(text=user_prompt))
        except Exception as e:
            logger.exception("coaching assistant AI call failed")
            raise HTTPException(status_code=502, detail="The AI call failed. Try again shortly.") from e

    # Persist messages
    user_msg = {"role": "user", "text": question, "citations": [], "at": _now()}
    bot_msg = {"role": "assistant", "text": response_text or "", "citations": citation_ids, "at": _now()}
    await db.coaching_assistant_conversations.update_one(
        {"id": conv["id"], "user_id": user_id},
        {
            "$push": {"messages": {"$each": [user_msg, bot_msg]}},
            "$set": {"updated_at": _now()},
        },
    )

    return {
        "conversation_id": conv["id"],
        "user_message": _serialize_msg(user_msg),
        "assistant_message": _serialize_msg(bot_msg),
        "citations": [_serialize_impact(s) for s in snippets],
    }
