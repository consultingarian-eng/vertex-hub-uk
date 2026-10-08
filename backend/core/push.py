"""Expo push notification helpers. Fails silently — notifications are best-effort."""
import os
import logging
from bson import ObjectId
from database import db

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

# ── Notification preference categories ───────────────────────────────────
# Every push data["type"] maps to one stable category key. Users switch
# categories on/off from the Inbox settings sheet; choices persist as
# users.notification_prefs = {category_key: bool}. A missing doc field,
# missing key, or unreadable prefs all mean ENABLED — off is always an
# explicit choice. `roles` limits which rows the settings screen SHOWS
# (None = everyone); enforcement applies to whatever actually arrives,
# whoever the user is.
NOTIFICATION_CATEGORIES = [
    {"key": "announcements", "label": "Announcements",
     "description": "Admin broadcasts and weekly bulletin shares.",
     "roles": None},
    {"key": "grading", "label": "Grading reminders",
     "description": "Nudges when new-BA assessments are waiting on your grade.",
     "roles": ("leader", "admin")},
    {"key": "briefing", "label": "Assessment results",
     "description": "Your assessment results when a day gets graded.",
     "roles": ("trainee",)},
    {"key": "planning", "label": "Planner & Primetime",
     "description": "Weekly-planner and Primetime nudges.",
     "roles": ("leader", "admin")},
    {"key": "coaching", "label": "Coaching & recordings",
     "description": "Recording analyses and coach comments.",
     "roles": None},
    {"key": "schedule", "label": "Schedule & absences",
     "description": "Schedule-block reminders and absence requests/decisions.",
     "roles": None},
    {"key": "milestones", "label": "Milestones",
     "description": "Badges, advancements and new team members.",
     "roles": None},
    {"key": "other", "label": "Everything else",
     "description": "Anything that doesn't fit another category.",
     "roles": None},
]

_TYPE_TO_CATEGORY = {
    "broadcast": "announcements",
    "weekly_bulletins": "announcements",
    "grading_reminder": "grading",
    "orientation_grading": "grading",
    "morning_briefing": "briefing",
    "assessment_complete": "briefing",
    "weekly_planner_nudge": "planning",
    "primetime_nudge": "planning",
    "ci_ready": "coaching",
    "ci_comment": "coaching",
    "zero_days": "coaching",        # two zero days in a row → needs a retrain
    "schedule": "schedule",
    "absence_request": "schedule",
    "absence_decision": "schedule",
    "badge_earned": "milestones",
    "promotion": "milestones",
    "new_hire": "milestones",
}


def notification_category(data: dict = None) -> str:
    """Category key for a push payload; unknown or missing type → 'other'."""
    return _TYPE_TO_CATEGORY.get((data or {}).get("type") or "", "other")


def is_category_enabled(user: dict, data: dict = None) -> bool:
    """False only when this user has explicitly switched the payload's
    category off. Missing prefs, missing key, or malformed data → enabled."""
    try:
        prefs = (user or {}).get("notification_prefs")
        if not isinstance(prefs, dict):
            return True
        return prefs.get(notification_category(data)) is not False
    except Exception:
        return True


async def is_category_enabled_for_user_id(user_id: str, data: dict = None) -> bool:
    """The same gate for callers that only hold a user id (e.g. the schedule
    web-push path). A prefs READ failure must never block a send → True."""
    try:
        user = await db.users.find_one(
            {"_id": ObjectId(user_id)}, {"notification_prefs": 1}
        )
        return is_category_enabled(user, data)
    except Exception:
        return True

async def send_push_to_token(token: str, title: str, body: str, data: dict = None):
    """Send a single push notification via Expo Push API. Fails silently."""
    if not token or not token.startswith("ExponentPushToken"):
        return
    try:
        import httpx
        payload = {
            "to": token,
            "title": title,
            "body": body,
            "sound": "default",
            "priority": "high",
            "data": data or {},
        }
        async with httpx.AsyncClient(timeout=8.0) as http:
            r = await http.post(EXPO_PUSH_URL, json=payload, headers={
                "Accept": "application/json",
                "Accept-Encoding": "gzip, deflate",
                "Content-Type": "application/json",
            })
            # HTTP 200 only means Expo ACCEPTED the request — the per-message
            # ticket in the body says whether it will actually be delivered.
            # Without this a dead token logged exactly like a success, so
            # "did they get it?" was unanswerable from the logs.
            ticket_status, ticket_err = _read_ticket(r)
            if ticket_status == "error":
                logger.warning(
                    f"Expo push to {token[:20]}... title='{title}' REJECTED: {ticket_err}"
                )
                # A token for an app that's been uninstalled/reinstalled is
                # dead forever — drop it so we stop pretending we notified them.
                if ticket_err == "DeviceNotRegistered":
                    try:
                        await db.users.update_many(
                            {"expo_push_token": token}, {"$unset": {"expo_push_token": ""}}
                        )
                        logger.info(f"Cleared dead Expo token {token[:20]}...")
                    except Exception as e:
                        logger.error(f"Could not clear dead Expo token: {e}")
            else:
                logger.info(
                    f"Expo push to {token[:20]}... title='{title}' "
                    f"status={r.status_code} ticket={ticket_status or 'unknown'}"
                )
    except Exception as e:
        logger.error(f"Expo push error to {token[:20]}...: {e}")


def _read_ticket(r) -> tuple:
    """(status, error_code) from an Expo push response. `data` is an object for
    a single recipient and a list for a batch; tolerate both plus junk bodies."""
    try:
        d = (r.json() or {}).get("data")
        if isinstance(d, list):
            d = d[0] if d else None
        if not isinstance(d, dict):
            return None, None
        return d.get("status"), ((d.get("details") or {}).get("error") or d.get("message"))
    except Exception:
        return None, None

async def send_push_to_user(user_id: str, title: str, body: str, data: dict = None):
    """Notify a user across every channel they have — native Expo push (Expo Go
    app) AND web push (installed PWA on iOS/Android). Best-effort; fails silently.

    All existing notification triggers call this, so wiring web push in here
    lights it up everywhere without touching call sites."""
    user = None
    found = False
    try:
        user = await db.users.find_one({"_id": ObjectId(user_id)})
        if not user:
            return
        found = True
    except Exception as e:
        logger.error(f"send_push_to_user (lookup) error for {user_id}: {e}")

    # Preference gate — off means off: a disabled category skips the Expo
    # push, the inbox row AND web push. Only an explicit False in the user's
    # notification_prefs suppresses; a failed lookup above falls through and
    # sends as before — a prefs read failure must never block a send.
    if found and not is_category_enabled(user, data):
        logger.info(
            f"Push to {user_id} suppressed by prefs "
            f"(category={notification_category(data)})."
        )
        return

    # Native Expo push (Expo Go / native builds)
    try:
        if user and user.get("expo_push_token"):
            await send_push_to_token(user["expo_push_token"], title, body, data)
        elif found:
            logger.info(f"No Expo push token for user {user_id}.")
    except Exception as e:
        logger.error(f"send_push_to_user (expo) error for {user_id}: {e}")

    # In-app inbox — every push also lands as a `notifications` row so a user
    # who missed the banner can still catch up. Same channel-choke-point trick
    # as web push: wiring it here covers every existing trigger. Best-effort.
    try:
        from core.notify import record_notification
        await record_notification(
            user_id, title, body, data=data,
            office_id=(user or {}).get("office_id"),
        )
    except Exception as e:
        logger.error(f"send_push_to_user (inbox) error for {user_id}: {e}")

    # Web push (installed PWA) — separate channel, own subscriptions
    try:
        from core.webpush import send_web_push_to_user
        await send_web_push_to_user(user_id, title, body, data)
    except Exception as e:
        logger.error(f"send_push_to_user (web) error for {user_id}: {e}")
