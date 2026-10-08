"""Admin action audit trail (IMPROVEMENT-PACK A5, light).

audit() is fire-and-forget safe — a failed audit write logs a warning and
never raises, so it can never break the admin action being audited.

Collection `admin_audit_log`:
  {id, actor_id, actor_name, action, target, details, office_id, created_at}
"""
import logging
import uuid
from datetime import datetime, timezone

from database import db

logger = logging.getLogger(__name__)


async def audit(actor_user: dict, action: str, target: str = None, details: dict = None):
    """Insert one admin_audit_log row. Best-effort — never raises."""
    try:
        actor_user = actor_user or {}
        await db.admin_audit_log.insert_one({
            "id": str(uuid.uuid4()),
            "actor_id": actor_user.get("id"),
            "actor_name": actor_user.get("name"),
            "action": action,
            "target": target,
            "details": details or {},
            "office_id": actor_user.get("office_id"),
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.warning(f"audit write failed for action '{action}': {e}")
