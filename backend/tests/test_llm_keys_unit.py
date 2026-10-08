"""core/llm_keys — one obviously-named key (ANTHROPIC_API_KEY) powers every
AI feature; EMERGENT_LLM_KEY is only a silent fallback for older configs."""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.llm_keys import anthropic_api_key, llm_configured  # noqa: E402


def test_anthropic_key_wins(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", " sk-ant-primary ")
    monkeypatch.setenv("EMERGENT_LLM_KEY", "sk-ant-legacy")
    assert anthropic_api_key() == "sk-ant-primary"


def test_emergent_key_is_a_fallback(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("EMERGENT_LLM_KEY", "sk-ant-legacy")
    assert anthropic_api_key() == "sk-ant-legacy"
    assert llm_configured() is True


def test_nothing_set_means_not_configured(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("EMERGENT_LLM_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "not-an-llm-key-here")
    assert anthropic_api_key() == ""
    assert llm_configured() is False
