"""The one LLM key the backend needs.

Every AI feature calls Anthropic (Claude): the vendored
`emergentintegrations` shim (reports, letters, coaching assistant, planner
coach, daily breakdown, quizzes, sheet/photo OCR). Set ANTHROPIC_API_KEY. EMERGENT_LLM_KEY
is still accepted as a silent fallback for older deployments that stored the
same Anthropic key under that name.
"""
from __future__ import annotations

import os


def anthropic_api_key() -> str:
    """ANTHROPIC_API_KEY, else EMERGENT_LLM_KEY, else ""."""
    return (
        (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
        or (os.environ.get("EMERGENT_LLM_KEY") or "").strip()
    )


def llm_configured() -> bool:
    return bool(anthropic_api_key())
