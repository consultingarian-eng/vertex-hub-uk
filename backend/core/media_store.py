"""Badge photos and profile avatars live in the R2 bucket, not in Mongo.

Why: a badge photo averaged ~500 KB of base64 and an avatar ~64 KB, and every
list that carried an avatar re-sent it as JSON on each request. In R2 the
photo is a plain file; Mongo keeps only its key.

Two different read paths, on purpose:

* Avatars get a real URL (`/api/media/avatars/...`) stored in the user's
  `profile_image`, so every screen that already renders `profile_image` as an
  image source keeps working and the browser caches the file forever. The key
  carries a random part, so the URL cannot be guessed from a user id.
* Badge photos stay behind the badge API. `GET /badges/{id}` reads the file
  from R2 and returns it as `photo_base64` exactly as before, so the badge
  editor, preview and print export need no change. Badges are opened one at
  a time by leaders, so the extra read is not on any hot path.

When the bucket is not configured (local runs, tests) everything falls back
to the old inline base64 storage.
"""
from __future__ import annotations

import base64
import hashlib
import io
import logging
import os
import re
import uuid
from typing import Optional, Tuple

from core import object_storage

logger = logging.getLogger(__name__)

AVATAR_PREFIX = "avatars/"
BADGE_PREFIX = "badges/"
AVATAR_MAX_SIDE = 512
MEDIA_ROUTE = "/api/media/"

# avatars/<user id>/<32 hex>.jpg — the only shape the public media route serves.
AVATAR_KEY_RE = re.compile(r"^avatars/[A-Za-z0-9_-]{1,64}/[0-9a-f]{32}\.jpg$")


def enabled() -> bool:
    return object_storage.is_configured()


def decode_image(value: str) -> bytes:
    """Accept a data URI or bare base64 and return the raw bytes.
    Raises ValueError on anything that is not decodable base64."""
    s = (value or "").strip()
    if s.startswith("data:"):
        s = s.split(",", 1)[1] if "," in s else ""
    if not s:
        raise ValueError("empty image")
    try:
        return base64.b64decode(s, validate=False)
    except Exception as ex:  # binascii.Error
        raise ValueError("invalid base64 image") from ex


def sniff_mime(raw: bytes) -> str:
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def _base_url() -> str:
    # APP_BASE_URL makes avatar links absolute; unset, they are same-origin
    # relative paths (the backend serves the web app).
    from core.app_config import app_base_url
    return app_base_url()


def avatar_url(key: str) -> str:
    return f"{_base_url()}{MEDIA_ROUTE}{key}"


def key_from_avatar_url(url: Optional[str]) -> Optional[str]:
    """The R2 key behind one of our avatar URLs, or None for anything else
    (legacy data URIs, external URLs)."""
    if not url or MEDIA_ROUTE not in url:
        return None
    key = url.split(MEDIA_ROUTE, 1)[1]
    return key if AVATAR_KEY_RE.match(key) else None


def normalize_avatar(raw: bytes) -> bytes:
    """Square-ish avatar, longest side 512px, JPEG. Transparent areas go
    white rather than JPEG's default black."""
    from PIL import Image, ImageOps
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:
        pass
    img = Image.open(io.BytesIO(raw))
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")
    if max(img.size) > AVATAR_MAX_SIDE:
        img.thumbnail((AVATAR_MAX_SIDE, AVATAR_MAX_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85, optimize=True)
    return out.getvalue()


async def store_avatar(user_id: str, image: str) -> Tuple[str, str]:
    """Upload an avatar and return (public url, key).
    Raises ValueError for an unreadable image, RuntimeError if R2 refused it."""
    raw = decode_image(image)
    try:
        jpeg = normalize_avatar(raw)
    except Exception as ex:
        raise ValueError("unreadable image") from ex
    safe_uid = re.sub(r"[^A-Za-z0-9_-]", "", str(user_id))[:64] or "user"
    key = f"{AVATAR_PREFIX}{safe_uid}/{uuid.uuid4().hex}.jpg"
    if not await object_storage.put_bytes(key, jpeg, "image/jpeg"):
        raise RuntimeError("storage upload failed")
    return avatar_url(key), key


async def delete_avatar_url(url: Optional[str]) -> None:
    key = key_from_avatar_url(url)
    if key:
        await object_storage.delete(key)


def badge_photo_key(badge_id: str, raw: bytes) -> str:
    """Content-addressed: re-saving an unchanged photo maps to the same key,
    so an edit that only fixes the name does not upload the photo again."""
    digest = hashlib.sha256(raw).hexdigest()[:24]
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(sniff_mime(raw), "bin")
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "", str(badge_id))[:64] or "badge"
    return f"{BADGE_PREFIX}{safe_id}/{digest}.{ext}"


async def store_badge_photo(badge_id: str, photo: str, current_key: Optional[str] = None) -> str:
    """Upload a badge photo (data URI or base64) and return its key.
    Raises ValueError for undecodable input, RuntimeError if R2 refused it."""
    raw = decode_image(photo)
    key = badge_photo_key(badge_id, raw)
    if key == current_key:
        return key
    if not await object_storage.put_bytes(key, raw, sniff_mime(raw)):
        raise RuntimeError("storage upload failed")
    return key


async def load_badge_photo_b64(badge: dict) -> Optional[str]:
    """The badge photo as bare base64, from Mongo (legacy) or R2.
    None means the photo could not be read."""
    inline = badge.get("photo_base64")
    if inline:
        return inline
    key = badge.get("photo_key")
    if not key:
        return None
    raw = await object_storage.get_bytes(key)
    if raw is None:
        return None
    return base64.b64encode(raw).decode("ascii")
