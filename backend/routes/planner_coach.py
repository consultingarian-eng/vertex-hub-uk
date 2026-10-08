"""AI Coaching for the Monthly Planner — gives the leader concrete coaching
suggestions for SWOT entries and Gap Analysis traits via the LLM.

Two modes:
  * kind="swot"  — given the user's current SWOT + role, suggest 3 concise
                   bullet items for each empty quadrant (or all 4 if asked).
  * kind="gap"   — given a single low-scored leadership trait (e.g.
                   "Time-management" with score 2), return 3 actionable
                   coaching tips tailored for a field-sales leader.

Returns plain JSON. No DB writes — the leader can copy/apply suggestions
into their planner if they want to keep them.
"""
import os
import re
import json
import asyncio
import logging
import uuid
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from auth import get_current_user
from core.llm_keys import anthropic_api_key
from core.rate_limit import take_ai_quota
from core.llm_guard import acquire_llm_slot
from core.brand import BRITISH_ENGLISH, SELF_EMPLOYED_TERMS, role_label

load_dotenv()
logger = logging.getLogger(__name__)
router = APIRouter()




# ─── Models ─────────────────────────────────────────────────────────────────


class CoachRequest(BaseModel):
    kind: str                                  # "swot" | "gap"
    role: Optional[str] = None                 # "leader" | "admin" | "trainee"
    # SWOT mode — current entries + which quadrants to fill (default: empty ones)
    swot_current: Optional[dict] = None
    swot_target: Optional[List[str]] = None    # subset of strengths/weaknesses/opportunities/threats
    # Gap mode — one trait at a time
    trait: Optional[str] = None
    score: Optional[int] = None                # 0..5
    # Optional context (helps the model)
    context: Optional[str] = None              # e.g. "field sales, door-to-door, energy"


class CoachResponse(BaseModel):
    kind: str
    suggestions: dict = Field(default_factory=dict)


# ─── Prompt builders ───────────────────────────────────────────────────────


SWOT_PROMPT = """You are a leadership coach for a network of self-employed Brand Ambassadors who fundraise door to door.
The user is filling out a Monthly Planner SWOT analysis. Their role: {role}.

Their current entries (may be partial or empty):
- Strengths: {strengths}
- Weaknesses: {weaknesses}
- Opportunities: {opportunities}
- Threats: {threats}

Generate FOR EACH OF THESE QUADRANTS that needs filling: {targets}
- 3 short bullet suggestions (max 12 words each)
- Concrete, behaviour-based, actionable — not vague platitudes
- Tone: peer coach. No fluff. No headers, no "Here are some...".

Respond ONLY with valid JSON in this shape (omit keys that aren't in `targets`):
{{
  "strengths": ["...", "...", "..."],
  "weaknesses": ["...", "...", "..."],
  "opportunities": ["...", "...", "..."],
  "threats": ["...", "...", "..."]
}}
"""


GAP_PROMPT = """You are a leadership coach for a network of self-employed Brand Ambassadors who fundraise door to door.
The coach rated themselves on the leadership trait "{trait}" with a score of {score}/5.
{score_descriptor}

Give 3 SPECIFIC, ACTIONABLE coaching tips to improve this trait OVER THE NEXT 30 DAYS.
- Each tip ≤ 18 words
- Each tip should be a behaviour they can DO this week (not a feeling or value)
- Tone: peer coach, direct, encouraging. No fluff.

Respond ONLY with valid JSON:
{{
  "tips": ["tip 1", "tip 2", "tip 3"],
  "headline": "one short sentence summarising the focus area (≤ 12 words)"
}}
"""


def _score_descriptor(score: Optional[int]) -> str:
    if score is None:
        return ""
    if score <= 1:
        return "This is currently a major weak spot — they need foundational habits."
    if score == 2:
        return "Below average — solid fundamentals are missing."
    if score == 3:
        return "Average — there are inconsistencies preventing them from levelling up."
    if score == 4:
        return "Strong — small refinements will push this to elite."
    return "Already elite — push towards modelling/teaching others."


# ─── Endpoint ──────────────────────────────────────────────────────────────


@router.post("/monthly-planners/ai-coach", response_model=CoachResponse)
async def ai_coach(req: CoachRequest, request: Request):
    """Generate AI coaching suggestions for a SWOT quadrant or a Gap trait.
    Read-only — does not write to the planner."""
    user = await get_current_user(request)
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    take_ai_quota(user)  # per-person hourly AI cap (core/rate_limit.py)

    if not anthropic_api_key():
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured")

    # Build the prompt
    if req.kind == "swot":
        cur = req.swot_current or {}
        targets = req.swot_target or [k for k, v in cur.items() if not (v or "").strip()] or [
            "strengths", "weaknesses", "opportunities", "threats"
        ]
        prompt = SWOT_PROMPT.format(
            role=role_label(req.role or user.get("role") or "leader"),
            strengths=cur.get("strengths") or "(empty)",
            weaknesses=cur.get("weaknesses") or "(empty)",
            opportunities=cur.get("opportunities") or "(empty)",
            threats=cur.get("threats") or "(empty)",
            targets=", ".join(targets),
        )
    elif req.kind == "gap":
        if not req.trait:
            raise HTTPException(status_code=400, detail="trait is required for kind=gap")
        prompt = GAP_PROMPT.format(
            trait=req.trait,
            score=req.score if req.score is not None else "?",
            score_descriptor=_score_descriptor(req.score),
        )
    else:
        raise HTTPException(status_code=400, detail="kind must be 'swot' or 'gap'")

    # Call the model via emergentintegrations
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"LLM library missing: {ex}")

    chat = LlmChat(
        api_key=anthropic_api_key(),
        session_id=f"planner-coach-{uuid.uuid4().hex[:10]}",
        system_message=(
            "You are a senior leadership coach. "
            "Always respond with valid JSON only. No prose outside the JSON. "
            + BRITISH_ENGLISH + " " + SELF_EMPLOYED_TERMS
        ),
    ).with_model("anthropic")

    msg = UserMessage(text=prompt)
    # Concurrency guard — only the model call holds a slot; prompt building
    # above and JSON parsing below stay outside it.
    async with acquire_llm_slot():
        try:
            response = await asyncio.wait_for(chat.send_message(msg), timeout=25)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="Coach timed out. Try again.")
        except Exception:
            logger.exception("planner coach AI call failed")
            raise HTTPException(status_code=502, detail="The AI call failed. Try again shortly.")

    raw = response if isinstance(response, str) else str(response)
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    if not cleaned.startswith("{"):
        m = re.search(r"\{.*\}", cleaned, flags=re.S)
        if m:
            cleaned = m.group(0)
    try:
        parsed = json.loads(cleaned)
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"Could not parse coach JSON: {ex}. Raw: {raw[:200]}")

    return CoachResponse(kind=req.kind, suggestions=parsed)
