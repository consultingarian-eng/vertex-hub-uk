"""S3-compatible object storage for Conversation Intelligence audio.

Audio never lives in Mongo/GridFS (the Atlas cluster has a ~512MB soft cap and
the API container also serves the SPA). Devices upload directly to the bucket
via presigned PUT; playback uses short-lived presigned GET. Cloudflare R2 is
the intended backend but anything S3-compatible works — configuration is via
env only:

    CI_S3_ENDPOINT            e.g. https://<account>.r2.cloudflarestorage.com
    CI_S3_BUCKET
    CI_S3_ACCESS_KEY_ID
    CI_S3_SECRET_ACCESS_KEY
    CI_S3_REGION              "auto" for R2 (default)

boto3 calls are sync; they only sign URLs / issue small HEAD+DELETE requests,
so they run in a thread via asyncio.to_thread to keep the event loop clean.
"""
import asyncio
import os
import logging
from functools import lru_cache

logger = logging.getLogger(__name__)

PUT_URL_TTL_S = 15 * 60
GET_URL_TTL_S = 10 * 60
STT_GET_URL_TTL_S = 4 * 60 * 60  # transcription providers fetch asynchronously

MAX_CHUNK_BYTES = 64 * 1024 * 1024  # hard sanity cap; ~60s of speech audio is ~<1MB
ALLOWED_AUDIO_MIME = {
    "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac",
    "audio/ogg", "audio/opus", "audio/webm", "audio/wav", "audio/mpeg",
}


def is_configured() -> bool:
    return all(
        os.environ.get(k, "").strip()
        for k in ("CI_S3_ENDPOINT", "CI_S3_BUCKET", "CI_S3_ACCESS_KEY_ID", "CI_S3_SECRET_ACCESS_KEY")
    )


@lru_cache(maxsize=1)
def _client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=os.environ["CI_S3_ENDPOINT"].strip(),
        aws_access_key_id=os.environ["CI_S3_ACCESS_KEY_ID"].strip(),
        aws_secret_access_key=os.environ["CI_S3_SECRET_ACCESS_KEY"].strip(),
        region_name=(os.environ.get("CI_S3_REGION") or "auto").strip() or "auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def _bucket() -> str:
    return os.environ["CI_S3_BUCKET"].strip()


def object_key(office_id: str, user_id: str, session_id: str, seq: int, ext: str = "m4a") -> str:
    # Server-generated only — client input never reaches the key.
    return f"ci/{office_id}/{user_id}/{session_id}/{int(seq):06d}.{ext}"


async def presign_put(key: str, content_type: str, size_bytes: int) -> str:
    def _sign():
        return _client().generate_presigned_url(
            "put_object",
            Params={"Bucket": _bucket(), "Key": key, "ContentType": content_type},
            ExpiresIn=PUT_URL_TTL_S,
        )
    return await asyncio.to_thread(_sign)


async def presign_get(key: str, ttl_s: int = GET_URL_TTL_S) -> str:
    def _sign():
        return _client().generate_presigned_url(
            "get_object",
            Params={"Bucket": _bucket(), "Key": key},
            ExpiresIn=ttl_s,
        )
    return await asyncio.to_thread(_sign)


async def put_bytes(key: str, data: bytes, content_type: str) -> bool:
    """Server-side upload — used only by the PWA relay fallback when the
    browser cannot PUT directly to the bucket (CORS not yet configured).
    Native apps always upload direct via presigned PUT."""
    def _put():
        try:
            _client().put_object(Bucket=_bucket(), Key=key, Body=data,
                                 ContentType=content_type)
            return True
        except Exception as ex:
            logger.error(f"ci storage put_bytes failed for {key}: {ex}")
            return False
    return await asyncio.to_thread(_put)


async def get_bytes(key: str):
    """Read a whole object. Returns bytes, or None if it is missing or the
    read failed (logged). Used for small objects only — photos, not audio."""
    def _get():
        try:
            r = _client().get_object(Bucket=_bucket(), Key=key)
            return r["Body"].read()
        except Exception as ex:
            logger.error(f"storage get_bytes failed for {key}: {ex}")
            return None
    return await asyncio.to_thread(_get)


async def head(key: str):
    """Return {size, content_type} or None if the object does not exist."""
    def _head():
        try:
            r = _client().head_object(Bucket=_bucket(), Key=key)
            return {"size": int(r.get("ContentLength", 0)), "content_type": r.get("ContentType", "")}
        except Exception:
            return None
    return await asyncio.to_thread(_head)


async def delete(key: str) -> bool:
    def _delete():
        try:
            _client().delete_object(Bucket=_bucket(), Key=key)
            return True
        except Exception as ex:
            logger.error(f"ci storage delete failed for {key}: {ex}")
            return False
    return await asyncio.to_thread(_delete)
