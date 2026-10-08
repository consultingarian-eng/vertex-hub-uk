"""Public media route: serves avatar files out of the R2 bucket.

GET /api/media/avatars/<user id>/<random>.jpg

No auth header, because <img> tags and React Native <Image> cannot send one.
The random part of the key is the access control: the URL is only ever handed
out inside authenticated API responses. Each upload gets a new key, so the
file behind a URL never changes and browsers may cache it for a year.
"""
from fastapi import APIRouter, HTTPException, Response

from core import media_store, object_storage

router = APIRouter()


@router.get("/media/{key:path}")
async def get_media(key: str):
    if not media_store.AVATAR_KEY_RE.match(key) or not media_store.enabled():
        raise HTTPException(status_code=404, detail="Not found")
    raw = await object_storage.get_bytes(key)
    if raw is None:
        raise HTTPException(status_code=404, detail="Not found")
    return Response(
        content=raw,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )
