"""Web Push (VAPID) — notifications for the installed PWA (iOS Home Screen +
Android/Chrome). Parallel to the native Expo push in core/push.py.

Subscriptions live in `web_push_subscriptions` (one doc per browser endpoint,
tagged with user_id). send_web_push_to_user() delivers to every subscription a
user has and prunes dead ones (404/410). Best-effort — never raises to callers.

Env (set on Railway):
  VAPID_PUBLIC_KEY   base64url raw public point — also served to the client
  VAPID_PRIVATE_KEY  base64url raw private scalar
  VAPID_SUBJECT      contact for push services: "mailto:you@example.org" or an
                     https URL (falls back to APP_BASE_URL, then to the
                     SENDGRID_FROM_EMAIL address)
"""
import os
import json
import asyncio
import logging

from database import db

logger = logging.getLogger(__name__)


# The push services browsers actually use. A subscription endpoint must be an
# https URL on one of these hosts (or a subdomain of one), so the server never
# POSTs to an address a user typed in (another site, or a private network).
PUSH_SERVICE_HOSTS = (
    "fcm.googleapis.com",            # Chrome, Edge, Android
    "android.googleapis.com",        # older Chrome endpoints
    "push.services.mozilla.com",     # Firefox (updates.push.services.mozilla.com)
    "push.apple.com",                # Safari / iOS Home Screen apps (web.push.apple.com)
    "notify.windows.com",            # Windows (wns2-*.notify.windows.com)
)
MAX_ENDPOINT_LENGTH = 1024


def is_allowed_push_endpoint(endpoint: str) -> bool:
    from urllib.parse import urlparse
    e = (endpoint or "").strip()
    if not e or len(e) > MAX_ENDPOINT_LENGTH:
        return False
    try:
        u = urlparse(e)
        host = (u.hostname or "").lower().rstrip(".")
        port = u.port
    except ValueError:
        return False
    if u.scheme != "https" or u.username or u.password or port not in (None, 443):
        return False
    return any(host == h or host.endswith("." + h) for h in PUSH_SERVICE_HOSTS)


def vapid_public_key() -> str:
    return (os.getenv("VAPID_PUBLIC_KEY") or "")


def _vapid_subject() -> str:
    """The contact push services require on every VAPID JWT."""
    sub = (os.getenv("VAPID_SUBJECT") or "").strip()
    if sub:
        return sub
    base = (os.getenv("APP_BASE_URL") or "").strip().rstrip("/")
    if base.startswith("https://"):
        return base
    sender = (os.getenv("SENDGRID_FROM_EMAIL") or "").strip()
    return f"mailto:{sender}" if sender else ""


def _configured() -> bool:
    return bool(os.getenv("VAPID_PRIVATE_KEY") and os.getenv("VAPID_PUBLIC_KEY"))


def _send_one(subscription: dict, payload: dict) -> int | None:
    """Blocking send of one web push. Returns HTTP status, or None on error.
    Runs in a thread (pywebpush is synchronous)."""
    from pywebpush import webpush, WebPushException
    from py_vapid import Vapid01
    try:
        vapid = Vapid01.from_raw((os.getenv("VAPID_PRIVATE_KEY") or "").encode())
        resp = webpush(
            subscription_info=subscription,
            data=json.dumps(payload),
            vapid_private_key=vapid,
            vapid_claims={"sub": _vapid_subject()},
            ttl=86400,
        )
        return resp.status_code
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        if code in (404, 410):
            return code  # dead subscription — caller prunes
        logger.warning("web push failed: %s", str(e)[:160])
        return code
    except Exception as e:
        logger.error("web push error: %s", str(e)[:160])
        return None


async def send_web_push_to_user(user_id: str, title: str, body: str, data: dict | None = None):
    """Fan a notification out to all of a user's web-push subscriptions."""
    if not _configured():
        return
    try:
        subs = await db.web_push_subscriptions.find({"user_id": str(user_id)}).to_list(length=50)
    except Exception as e:
        logger.error("web push: load subs failed for %s: %s", user_id, e)
        return
    if not subs:
        return

    url = (data or {}).get("url") or "/"
    payload = {"title": title, "body": body, "url": url, "data": data or {}}
    # Unread inbox count, so the service worker can put the number on the
    # installed app's icon while the app is closed. Best-effort.
    try:
        payload["badge"] = await db.notifications.count_documents({"user_id": str(user_id), "read": {"$ne": True}})
    except Exception:
        pass
    dead: list = []
    for s in subs:
        info = {"endpoint": s.get("endpoint"), "keys": s.get("keys")}
        if not info["endpoint"] or not info["keys"]:
            continue
        if not is_allowed_push_endpoint(info["endpoint"]):
            dead.append(info["endpoint"])  # stored before the allowlist: drop it
            continue
        status = await asyncio.to_thread(_send_one, info, payload)
        if status in (404, 410):
            dead.append(s.get("endpoint"))
    if dead:
        try:
            await db.web_push_subscriptions.delete_many({"endpoint": {"$in": dead}})
            logger.info("web push: pruned %d dead subscriptions", len(dead))
        except Exception:
            pass
