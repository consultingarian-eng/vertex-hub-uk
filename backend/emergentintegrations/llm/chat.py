"""Drop-in replacement for emergentintegrations.llm.chat, backed by Claude.

The original `emergentintegrations` package (Emergent's LLM gateway) isn't on
PyPI, so it can't be installed off-Emergent — which left every AI feature dark
on Railway. This shim keeps the exact same import + API surface
(`LlmChat`, `UserMessage`, `ImageContent`, `FileContentWithMimeType`) so NO call
site changes, but routes everything to the Anthropic SDK using ANTHROPIC_API_KEY
(EMERGENT_LLM_KEY is accepted as a fallback name — see core/llm_keys.py).

Claude handles both text and vision/PDF, so calls that previously used Gemini
for OCR are routed to Claude too — one key powers all AI features (reports,
letter drafting, sheet/photo OCR). The `api_key` passed by call sites is
ignored; the key always comes from core.llm_keys.anthropic_api_key().

Model choice lives in ONE place: no call site names a model id. Every call
uses ANTHROPIC_MODEL; the photo/sheet-reading calls (which originally named a
separate vision model) may use ANTHROPIC_VISION_MODEL instead, and fall back
to ANTHROPIC_MODEL when it is unset. When Anthropic retires a model, change
the setting (or FALLBACK_MODEL below), never the call sites.

Env:
  ANTHROPIC_API_KEY      required for any AI feature to work
  ANTHROPIC_MODEL        the model for every AI feature (default: FALLBACK_MODEL)
  ANTHROPIC_VISION_MODEL optional override for photo/sheet reading only
  ANTHROPIC_MAX_TOKENS   output cap (default: 8192)
"""
import os
import base64
import logging

logger = logging.getLogger(__name__)

FALLBACK_MODEL = "claude-sonnet-5-5"


def default_model() -> str:
    """ANTHROPIC_MODEL, read at call time, else FALLBACK_MODEL."""
    return (os.getenv("ANTHROPIC_MODEL") or "").strip() or FALLBACK_MODEL


def vision_model() -> str:
    """ANTHROPIC_VISION_MODEL for photo/sheet reading, else default_model()."""
    return (os.getenv("ANTHROPIC_VISION_MODEL") or "").strip() or default_model()


# Kept for older imports; reads the environment once at import.
DEFAULT_MODEL = default_model()
MAX_TOKENS = int((os.getenv("ANTHROPIC_MAX_TOKENS") or "8192"))


class ImageContent:
    def __init__(self, image_base64: str, mime_type: str | None = None):
        self.image_base64 = image_base64
        self.mime_type = mime_type


class FileContentWithMimeType:
    def __init__(self, file_path: str, mime_type: str):
        self.file_path = file_path
        self.mime_type = mime_type


class UserMessage:
    def __init__(self, text: str = "", file_contents=None):
        self.text = text
        self.file_contents = file_contents or []


def _img_media_type(b64: str, fallback: str = "image/jpeg") -> str:
    """Sniff an image's media type from the first bytes of its base64."""
    try:
        head = base64.b64decode(b64[:24])
        if head[:4] == b"\x89PNG":
            return "image/png"
        if head[:3] == b"\xff\xd8\xff":
            return "image/jpeg"
        if head[:4] == b"RIFF":
            return "image/webp"
        if head[:6] in (b"GIF87a", b"GIF89a"):
            return "image/gif"
    except Exception:
        pass
    return fallback


class LlmChat:
    def __init__(self, api_key=None, session_id=None, system_message: str = ""):
        # api_key (the Emergent proxy key) is intentionally ignored — we use
        # ANTHROPIC_API_KEY from the environment.
        self.system = system_message or ""
        self.session_id = session_id
        self.model = default_model()

    def with_model(self, provider: str, model: str | None = None):
        # Everything routes to Claude, and the model id always comes from the
        # environment (see the module docstring), never from the call site.
        # Calls that originally named another provider's vision model are the
        # photo/sheet readers: they may use ANTHROPIC_VISION_MODEL.
        self.model = default_model() if provider == "anthropic" else vision_model()
        return self

    def _content_blocks(self, msg) -> list:
        blocks: list = []
        text = getattr(msg, "text", "") or ""
        if text:
            blocks.append({"type": "text", "text": text})
        for fc in (getattr(msg, "file_contents", None) or []):
            if isinstance(fc, ImageContent):
                b64 = fc.image_base64
                blocks.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": fc.mime_type or _img_media_type(b64), "data": b64},
                })
            elif isinstance(fc, FileContentWithMimeType):
                with open(fc.file_path, "rb") as f:
                    data = base64.b64encode(f.read()).decode()
                if (fc.mime_type or "").lower() == "application/pdf":
                    blocks.append({
                        "type": "document",
                        "source": {"type": "base64", "media_type": "application/pdf", "data": data},
                    })
                else:
                    blocks.append({
                        "type": "image",
                        "source": {"type": "base64", "media_type": fc.mime_type or "image/jpeg", "data": data},
                    })
        if not blocks:
            blocks.append({"type": "text", "text": ""})
        return blocks

    async def send_message(self, msg) -> str:
        from core.llm_keys import anthropic_api_key
        key = anthropic_api_key()
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY not configured — AI features disabled")
        from anthropic import AsyncAnthropic

        client = AsyncAnthropic(api_key=key)
        kwargs = {
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "messages": [{"role": "user", "content": self._content_blocks(msg)}],
        }
        if self.system:
            kwargs["system"] = self.system
        resp = await client.messages.create(**kwargs)
        return "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
