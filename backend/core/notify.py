"""In-app notification inbox — every push also lands here so users can catch up.

record_notification() mirrors the best-effort semantics of core/push.py: any
failure logs a warning and never raises, so a broken inbox write can never
break the action that triggered the notification.

Collection `notifications`:
  {id, user_id, title, body, type, data, office_id, read, created_at}
"""
import logging
import uuid
from datetime import datetime, timezone

from database import db

logger = logging.getLogger(__name__)

# Per-user cap: after each insert, READ rows beyond the newest READ_CAP are
# pruned. Unread rows are never pruned — the unread badge must stay honest.
READ_CAP = 200


async def record_notification(user_id: str, title: str, body: str,
                              data: dict = None, office_id: str = None):
    """Insert one inbox row for a user. Best-effort — never raises."""
    try:
        data = data or {}
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": str(user_id),
            "title": title,
            "body": body,
            "type": data.get("type") or "general",
            "data": data,
            "office_id": office_id,
            "read": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        # Cheap best-effort cap — drop this user's read rows beyond the newest
        # READ_CAP. Anything a single pass misses is caught on the next insert.
        stale = await db.notifications.find(
            {"user_id": str(user_id), "read": True},
            {"_id": 0, "id": 1},
        ).sort("created_at", -1).skip(READ_CAP).to_list(1000)
        if stale:
            await db.notifications.delete_many(
                {"id": {"$in": [r["id"] for r in stale]}}
            )
    except Exception as e:
        logger.warning(f"record_notification failed for {user_id}: {e}")
