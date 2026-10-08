"""First-boot seeding: the owner's super-admin account and the first office.

Called from server.py's startup work on every boot; everything here is
idempotent.

  ADMIN_EMAIL + ADMIN_PASSWORD  create the super-admin the FIRST time only.
                                After that the password is the one set in
                                the app (Profile → Change password, or
                                Forgot password); a boot never resets it.
                                With either unset, no admin is seeded.
  ADMIN_PASSWORD_RESET=true     one-off recovery: on the next boot, set the
                                existing super-admin's password to
                                ADMIN_PASSWORD (signing out their sessions).
                                Remove it again straight after.
  ADMIN_NAME                    the admin's display name (default "Admin").
  SEED_OFFICE_NAME              name of the one office a fresh database gets
                                (default "Head Office"), seeded with the
                                default day targets and training manual.
                                More offices are created in-app
                                (POST /offices clones this office's content).
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone

from auth import hash_password, verify_password
from seed_data import DAY_TARGETS, TRAINING_MANUAL

logger = logging.getLogger(__name__)

DEFAULT_OFFICE_NAME = "Head Office"
DEFAULT_ADMIN_NAME = "Admin"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _reset_requested() -> bool:
    return (os.environ.get("ADMIN_PASSWORD_RESET") or "").strip().lower() in {"1", "true", "yes", "on"}


async def seed_admin(db) -> str:
    """Create the super-admin from env on first boot. Returns its email, or ""
    when ADMIN_EMAIL / ADMIN_PASSWORD are not both set.

    An existing account's password is left alone (a password changed in the
    app must survive the next deploy) unless ADMIN_PASSWORD_RESET is on."""
    admin_email = (os.environ.get("ADMIN_EMAIL") or "").strip().lower()
    admin_password = os.environ.get("ADMIN_PASSWORD")
    admin_name = (os.environ.get("ADMIN_NAME") or "").strip() or DEFAULT_ADMIN_NAME
    if not admin_email or not admin_password:
        logger.warning("ADMIN_EMAIL / ADMIN_PASSWORD not set; skipping admin seed.")
        return ""
    existing = await db.users.find_one({"email": admin_email})
    if existing is None:
        await db.users.insert_one({
            "email": admin_email,
            "password_hash": hash_password(admin_password),
            "name": admin_name,
            "role": "admin",
            "is_super_admin": True,
            "email_verified": True,
            "session_version": 0,
            "created_at": _now(),
        })
        logger.info(f"Seeded admin: {admin_email}")
        return admin_email
    if not existing.get("is_super_admin"):
        await db.users.update_one({"email": admin_email}, {"$set": {"is_super_admin": True}})
    if _reset_requested():
        if not verify_password(admin_password, existing.get("password_hash") or ""):
            await db.users.update_one(
                {"email": admin_email},
                {"$set": {"password_hash": hash_password(admin_password), "must_change_password": False},
                 "$inc": {"session_version": 1}},
            )
            logger.warning("ADMIN_PASSWORD_RESET: the super-admin password was reset from ADMIN_PASSWORD. "
                           "Remove ADMIN_PASSWORD_RESET now.")
        else:
            logger.warning("ADMIN_PASSWORD_RESET is set but the password already matches. Remove it.")
    return admin_email


async def seed_first_office(db) -> str | None:
    """On an empty offices collection, create ONE office (SEED_OFFICE_NAME)
    plus its day targets and training manual. Returns the new office id, or
    None when offices already exist."""
    if await db.offices.find_one():
        return None
    office_id = str(uuid.uuid4())
    office_name = (os.environ.get("SEED_OFFICE_NAME") or "").strip() or DEFAULT_OFFICE_NAME
    await db.offices.insert_one({
        "id": office_id, "name": office_name, "city": "", "state": "",
        "created_at": _now(),
    })
    logger.info(f"Seeded office: {office_name}")
    if not await db.targets.find_one():
        for t in DAY_TARGETS:
            await db.targets.insert_one({**t, "office_id": office_id})
        logger.info("Seeded day targets for the first office")
    if not await db.training_manual.find_one():
        for m in TRAINING_MANUAL:
            await db.training_manual.insert_one({**m, "office_id": office_id})
        logger.info("Seeded training manual for the first office")
    return office_id


async def give_admin_a_home_office(db, admin_email: str) -> None:
    """The seeded admin always has a home office: the oldest on this database
    (covers an admin added after the office was created)."""
    if not admin_email:
        return
    admin = await db.users.find_one({"email": admin_email}, {"office_id": 1, "accessible_offices": 1})
    if not admin or admin.get("office_id"):
        return
    first_office = await db.offices.find_one({}, sort=[("created_at", 1)])
    if not first_office or not first_office.get("id"):
        return
    accessible = list(admin.get("accessible_offices") or [])
    if first_office["id"] not in accessible:
        accessible.append(first_office["id"])
    await db.users.update_one(
        {"_id": admin["_id"]},
        {"$set": {"office_id": first_office["id"], "accessible_offices": accessible}},
    )


async def seed_admin_and_first_office(db) -> dict:
    admin_email = await seed_admin(db)
    office_id = await seed_first_office(db)
    await give_admin_a_home_office(db, admin_email)
    return {"admin_email": admin_email, "seeded_office_id": office_id}
