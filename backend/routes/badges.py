"""Badges endpoints: create/list/get/delete rep badges + Replicate rembg background removal.

Access model:
- Create/view/delete are limited to leaders + admins.
- Visibility is OFFICE-SCOPED: leaders and admins see only badges belonging to their
  own office. Super admins see every badge across all offices.
"""
import os
import uuid
import base64
import logging
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException, Request

from auth import can_use_badges, get_current_user
from database import db
from core.office_helpers import get_office_filter
from core import media_store, object_storage
from core.app_time import APP_TZ
from core.brand import ORG_NAME

logger = logging.getLogger(__name__)
router = APIRouter()

# A rep badge number: letters/digits, optionally dash-separated (e.g. "B1007",
# "VX-0042"). Deliberately loose — it only has to match what the field
# platform (OwnerIQ) shows for the rep.
BADGE_NUMBER_PATTERN = r"^[A-Z0-9][A-Z0-9-]{1,23}$"
_BADGE_NUMBER_HELP = "Badge number must be 2–24 letters, numbers or dashes"


def default_expiry(today=None) -> str:
    """Generation date + 1 year, DD/MM/YYYY (29 Feb → 28 Feb)."""
    d = today or datetime.now(APP_TZ).date()
    try:
        d = d.replace(year=d.year + 1)
    except ValueError:
        d = d.replace(year=d.year + 1, day=28)
    return d.strftime("%d/%m/%Y")


def badge_qr_url(badge_number: str) -> str:
    """What the badge's QR code encodes. BADGE_QR_URL_TEMPLATE (e.g.
    "https://example.org/verify?badge={badge_number}") makes it a link a
    member of the public can scan to verify the rep; unset, the QR simply
    carries the badge number."""
    template = (os.environ.get("BADGE_QR_URL_TEMPLATE") or "").strip()
    if template:
        return template.replace("{badge_number}", badge_number)
    return badge_number


@router.get("/badges/template")
async def badge_template(request: Request):
    """Printed-badge wording that comes from deployment config, not code:
    who the rep is authorised by (BADGE_ORG_NAME, default ORG_NAME) and the
    verification phone number printed on the back (BADGE_VERIFY_PHONE)."""
    user = await get_current_user(request)
    if not can_use_badges(user):
        raise HTTPException(status_code=403, detail="Badges are for Admins and Coach+ only")
    return {
        "authorized_by": (os.environ.get("BADGE_ORG_NAME") or "").strip() or ORG_NAME,
        "verify_phone": (os.environ.get("BADGE_VERIFY_PHONE") or "").strip(),
    }


async def _store_photo(badge_id: str, photo_base64: str, current_key: Optional[str] = None) -> str:
    """Upload a badge photo to R2 and return its key, as an HTTP error on failure."""
    try:
        return await media_store.store_badge_photo(badge_id, photo_base64, current_key)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")
    except RuntimeError:
        raise HTTPException(status_code=502, detail="Couldn't save the photo right now. Try again.")


async def _with_photo(badge: dict) -> dict:
    """Return the badge with `photo_base64` filled in, wherever the photo lives.
    The frontend (editor, preview, print export) still reads photo_base64."""
    if badge.get("photo_base64") or not badge.get("photo_key"):
        return badge
    b64 = await media_store.load_badge_photo_b64(badge)
    if b64 is None:
        raise HTTPException(status_code=503, detail="Couldn't load the badge photo. Try again.")
    return {**badge, "photo_base64": b64}


async def _user_by_id(user_id: str):
    """The account a badge is linked to. Accounts are keyed by Mongo _id (a
    few old ones also carry an `id`), so try both."""
    if not user_id:
        return None
    found = await db.users.find_one({"id": user_id})
    if not found:
        try:
            from bson import ObjectId
            found = await db.users.find_one({"_id": ObjectId(str(user_id))})
        except Exception:
            found = None
    return found


async def _badge_number_taken(badge_number: str, wearer: Optional[dict]) -> bool:
    """Does another live account already carry this badge number? A badge
    number is what ties a person to their OwnerIQ rows, so one number never
    belongs to two people."""
    import re as _re
    bn = (badge_number or "").strip()
    if not bn:
        return False
    q = {"amplifi_codes": {"$regex": f"^{_re.escape(bn)}$", "$options": "i"}, "deleted": {"$ne": True}}
    async for u in db.users.find(q, {"_id": 1}):
        if wearer is None or str(u["_id"]) != str(wearer.get("_id")):
            return True
    return False


def _can_access_badge(user: dict, badge: dict) -> bool:
    """Super admins see everything; everyone else only their own office."""
    if user.get("is_super_admin"):
        return True
    return (user.get("office_id") or "") == (badge.get("office_id") or "")


def generate_qr_base64(url: str) -> str:
    """Generate a QR code PNG as base64 (no data URI prefix)."""
    import qrcode, io
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")

async def remove_background_via_replicate(image_bytes: bytes) -> bytes:
    """Call Replicate cjwbw/rembg via HTTP to remove background. Returns PNG bytes."""
    import base64 as _b64
    import io as _io
    import httpx as _httpx
    from PIL import Image as _Image

    api_token = (os.environ.get("REPLICATE_API_TOKEN") or "").strip()
    if not api_token:
        raise RuntimeError("REPLICATE_API_TOKEN not configured")

    # Replicate data URI only recommended for < 1MB — cap at 800px to stay safe
    img = _Image.open(_io.BytesIO(image_bytes))
    if max(img.size) > 800:
        img.thumbnail((800, 800), _Image.LANCZOS)
    buf = _io.BytesIO()
    img.save(buf, format="JPEG", quality=85, optimize=True)
    image_bytes = buf.getvalue()

    b64_data = _b64.b64encode(image_bytes).decode("utf-8")

    async with _httpx.AsyncClient(timeout=90.0) as hc:
        resp = await hc.post(
            "https://api.replicate.com/v1/predictions",
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
                "Prefer": "wait",
            },
            json={
                "version": "fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003",
                "input": {"image": f"data:image/jpeg;base64,{b64_data}"},
            },
        )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Replicate error ({resp.status_code}): {resp.text[:300]}")

    data = resp.json()
    output = data.get("output")
    if not output:
        raise RuntimeError(f"Replicate returned no output (status: {data.get('status', 'unknown')})")

    output_url = output[0] if isinstance(output, list) else output

    async with _httpx.AsyncClient(timeout=30.0) as hc:
        dl = await hc.get(output_url)
        dl.raise_for_status()
        return dl.content


@router.post("/badges/remove-background")
async def badges_remove_background(request: Request):
    """Leader/Admin: submit a base64 photo (HEIC/HEIF/JPG/PNG OK), get back a base64 PNG with bg removed via Replicate rembg."""
    user = await get_current_user(request)
    if not can_use_badges(user):
        raise HTTPException(status_code=403, detail="Badges are for Admins and Coach+ only")
    body = await request.json()
    b64 = (body.get("image_base64") or "").strip()
    if not b64:
        raise HTTPException(status_code=400, detail="image_base64 is required")
    # Strip data: prefix if present
    if b64.startswith("data:"):
        try:
            b64 = b64.split(",", 1)[1]
        except Exception:
            pass
    try:
        raw = base64.b64decode(b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    # Detect + transcode HEIC/HEIF → JPEG (remove.bg only supports jpg/png/webp)
    import io as _io
    from PIL import Image as _Image, ImageOps as _ImageOps
    try:
        try:
            import pillow_heif as _pheif
            _pheif.register_heif_opener()
        except Exception:
            pass
        img = _Image.open(_io.BytesIO(raw))
        img = _ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        # Downsize oversized images to keep API under 25MP and speed up
        max_side = 2000
        if max(img.size) > max_side:
            img.thumbnail((max_side, max_side), _Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=92, optimize=True)
        upload_bytes = buf.getvalue()
    except Exception as e:
        logger.error(f"Image decode failed before remove.bg: {e}")
        raise HTTPException(status_code=400, detail="Couldn't read that image. Try a JPEG or PNG.")

    try:
        png_bytes = await remove_background_via_replicate(upload_bytes)
        result_b64 = base64.b64encode(png_bytes).decode("utf-8")
        return {"image_base64": result_b64}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Background removal failed: {e}")
        raise HTTPException(status_code=500, detail=f"Background removal failed: {e}")

@router.post("/badges")
async def create_badge(request: Request):
    """Leader/Admin: create (save) a badge for a person."""
    user = await get_current_user(request)
    if not can_use_badges(user):
        raise HTTPException(status_code=403, detail="Badges are for Admins and Coach+ only")
    body = await request.json()
    full_name = (body.get("full_name") or "").strip()
    badge_number = (body.get("badge_number") or "").strip().upper()
    photo_base64 = (body.get("photo_base64") or "").strip()
    if not full_name or len(full_name) < 2:
        raise HTTPException(status_code=400, detail="Full name is required")
    import re as _re
    if not _re.match(BADGE_NUMBER_PATTERN, badge_number):
        raise HTTPException(status_code=400, detail=_BADGE_NUMBER_HELP)
    if not photo_base64:
        raise HTTPException(status_code=400, detail="Photo is required")
    # Strip data: prefix if present
    if photo_base64.startswith("data:"):
        try:
            photo_base64 = photo_base64.split(",", 1)[1]
        except Exception:
            pass
    user_id = (body.get("user_id") or "").strip() or None
    # A badge is linked to an account only when the person was chosen
    # explicitly (the Badge Studio opened from their page) — never by the typed
    # name, because anyone can rename themselves and the badge number is what
    # links a person to their OwnerIQ rows. The chosen account must be live
    # and, unless the caller is the owner, in the caller's office.
    target_user = None
    if user_id:
        target_user = await _user_by_id(user_id)
        if not target_user or target_user.get("deleted"):
            raise HTTPException(status_code=404, detail="That person wasn't found.")
        if not user.get("is_super_admin") and (target_user.get("office_id") or "") != (user.get("office_id") or ""):
            raise HTTPException(status_code=403, detail="That person is in a different office.")
        if await _badge_number_taken(badge_number, target_user):
            raise HTTPException(status_code=409, detail="That badge number already belongs to someone else.")
    # Default expiry: one year from the day the badge is generated, written the
    # UK way (DD/MM/YYYY). A 29 February badge expires on 28 February.
    expiry_date = (body.get("expiry_date") or default_expiry()).strip()
    # Photo fit: zoom 1.0-1.8, vertical position 0-100
    try:
        photo_zoom = float(body.get("photo_zoom", 1.18))
    except Exception:
        photo_zoom = 1.18
    photo_zoom = max(1.0, min(1.8, photo_zoom))
    try:
        photo_position_y = int(body.get("photo_position_y", 30))
    except Exception:
        photo_position_y = 30
    photo_position_y = max(0, min(100, photo_position_y))
    qr_url = badge_qr_url(badge_number)
    qr_base64 = generate_qr_base64(qr_url)
    # Stamp the creator's office so the badge is visible to everyone in that office.
    # Super admins who haven't chosen an office fall back to their first accessible office.
    office_id = user.get("office_id") or ""
    if not office_id:
        first_office = await db.offices.find_one({}, sort=[("created_at", 1)])
        if first_office:
            office_id = first_office["id"]
    badge_id = str(uuid.uuid4())
    photo_key = None
    if media_store.enabled():
        photo_key = await _store_photo(badge_id, photo_base64)
    doc = {
        "id": badge_id,
        "user_id": user_id,
        "office_id": office_id,
        "full_name": full_name,
        "badge_number": badge_number,
        "photo_base64": photo_base64,
        "photo_zoom": photo_zoom,
        "photo_position_y": photo_position_y,
        "qr_base64": qr_base64,
        "qr_url": qr_url,
        "expiry_date": expiry_date,
        "created_by_id": user["id"],
        "created_by_name": user.get("name") or user.get("email", "Unknown"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if photo_key:
        # The photo lives in R2; Mongo keeps only its key.
        doc.pop("photo_base64")
        doc["photo_key"] = photo_key
    await db.badges.insert_one(doc)
    doc.pop("_id", None)
    if photo_key:
        doc["photo_base64"] = photo_base64  # response shape unchanged

    # Auto-link the badge number onto the chosen person's badge numbers
    # (`amplifi_codes`, historical name) so the OwnerIQ sync recognizes them
    # without an extra step. A badge made without choosing a person stays
    # unlinked.
    if target_user:
        existing = list(target_user.get("amplifi_codes") or [])
        bn_upper = badge_number.upper()
        user_update: dict = {"amplifi_codes_updated_at": datetime.now(timezone.utc).isoformat()}
        if bn_upper not in [str(c).upper() for c in existing]:
            existing.append(bn_upper)
            user_update["amplifi_codes"] = existing
        # Mark the user as a Badged BA — only stamp the date on first badge
        user_update["is_badged_ba"] = True
        if not target_user.get("badged_ba_at"):
            user_update["badged_ba_at"] = datetime.now(timezone.utc).isoformat()
        await db.users.update_one({"_id": target_user["_id"]}, {"$set": user_update})

    return doc

@router.patch("/badges/{badge_id}")
async def update_badge(badge_id: str, request: Request):
    """Leader/Admin: edit a saved badge in place — fix a wrong name, badge
    number (the QR code regenerates automatically), expiry, photo, or photo
    fit without recreating the badge. Office-scoped like every badge route."""
    user = await get_current_user(request)
    if not can_use_badges(user):
        raise HTTPException(status_code=403, detail="Badges are for Admins and Coach+ only")
    badge = await db.badges.find_one({"id": badge_id})
    if not badge:
        raise HTTPException(status_code=404, detail="Badge not found")
    if not _can_access_badge(user, badge):
        raise HTTPException(status_code=403, detail="This badge belongs to a different office")
    body = await request.json()
    updates: dict = {}
    unset: dict = {}
    replaced_key = None

    if "full_name" in body:
        full_name = (body.get("full_name") or "").strip()
        if len(full_name) < 2:
            raise HTTPException(status_code=400, detail="Full name is required")
        updates["full_name"] = full_name

    old_number = (badge.get("badge_number") or "").upper()
    new_number = None
    if "badge_number" in body:
        import re as _re
        candidate = (body.get("badge_number") or "").strip().upper()
        if not _re.match(BADGE_NUMBER_PATTERN, candidate):
            raise HTTPException(status_code=400, detail=_BADGE_NUMBER_HELP)
        if candidate != old_number:
            if badge.get("user_id"):
                wearer = await _user_by_id(badge["user_id"])
                if wearer and await _badge_number_taken(candidate, wearer):
                    raise HTTPException(status_code=409, detail="That badge number already belongs to someone else.")
            new_number = candidate
            qr_url = badge_qr_url(new_number)
            updates.update({
                "badge_number": new_number,
                "qr_url": qr_url,
                "qr_base64": generate_qr_base64(qr_url),
            })

    if "photo_base64" in body:
        photo_base64 = (body.get("photo_base64") or "").strip()
        if not photo_base64:
            raise HTTPException(status_code=400, detail="Photo is required")
        if photo_base64.startswith("data:"):
            try:
                photo_base64 = photo_base64.split(",", 1)[1]
            except Exception:
                pass
        if media_store.enabled():
            new_key = await _store_photo(badge_id, photo_base64, badge.get("photo_key"))
            updates["photo_key"] = new_key
            if new_key != badge.get("photo_key"):
                replaced_key = badge.get("photo_key")
        else:
            updates["photo_base64"] = photo_base64

    if "expiry_date" in body and (body.get("expiry_date") or "").strip():
        updates["expiry_date"] = (body.get("expiry_date") or "").strip()
    if "photo_zoom" in body:
        try:
            updates["photo_zoom"] = max(1.0, min(1.8, float(body.get("photo_zoom"))))
        except Exception:
            pass
    if "photo_position_y" in body:
        try:
            updates["photo_position_y"] = max(0, min(100, int(body.get("photo_position_y"))))
        except Exception:
            pass

    if updates:
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        updates["updated_by_name"] = user.get("name") or user.get("email", "Unknown")
        if "photo_key" in updates and badge.get("photo_base64"):
            unset["photo_base64"] = ""  # a legacy inline photo moves out with its first edit
        op = {"$set": updates}
        if unset:
            op["$unset"] = unset
        await db.badges.update_one({"id": badge_id}, op)
        if replaced_key:
            await object_storage.delete(replaced_key)

    # A corrected badge number must follow through to the wearer's
    # badge numbers — the OwnerIQ rep matching reads those. Drop the old
    # (wrong) code unless another of their badges still carries it, then add
    # the corrected one.
    if new_number and badge.get("user_id"):
        target_user = await _user_by_id(badge["user_id"])
        if target_user:
            codes = [str(c).upper() for c in (target_user.get("amplifi_codes") or [])]
            still_used = await db.badges.find_one({
                "user_id": badge["user_id"], "id": {"$ne": badge_id}, "badge_number": old_number,
            })
            if old_number in codes and not still_used:
                codes = [c for c in codes if c != old_number]
            if new_number not in codes:
                codes.append(new_number)
            await db.users.update_one(
                {"_id": target_user["_id"]},
                {"$set": {
                    "amplifi_codes": codes,
                    "amplifi_codes_updated_at": datetime.now(timezone.utc).isoformat(),
                }},
            )

    fresh = await db.badges.find_one({"id": badge_id}, {"_id": 0})
    return await _with_photo(fresh)


@router.get("/badges")
async def list_badges(request: Request, user_id: Optional[str] = None):
    """Leader/Admin: list saved badges scoped to the user's office (super admin sees all)."""
    user = await get_current_user(request)
    if not can_use_badges(user):
        raise HTTPException(status_code=403, detail="Badges are for Admins and Coach+ only")
    q = await get_office_filter(user)  # {} for super admin, else {"office_id": user["office_id"]}
    if user_id:
        q["user_id"] = user_id
    rows = await db.badges.find(q, {"_id": 0, "photo_base64": 0, "photo_key": 0, "qr_base64": 0}).sort("created_at", -1).to_list(300)
    return rows

@router.get("/badges/{badge_id}")
async def get_badge(badge_id: str, request: Request):
    """Leader/Admin: fetch a single badge (office-scoped; super admin can view any)."""
    user = await get_current_user(request)
    if not can_use_badges(user):
        raise HTTPException(status_code=403, detail="Badges are for Admins and Coach+ only")
    badge = await db.badges.find_one({"id": badge_id}, {"_id": 0})
    if not badge:
        raise HTTPException(status_code=404, detail="Badge not found")
    if not _can_access_badge(user, badge):
        raise HTTPException(status_code=403, detail="This badge belongs to a different office")
    return await _with_photo(badge)

@router.delete("/badges/{badge_id}")
async def delete_badge(badge_id: str, request: Request):
    """Leader/Admin: delete a badge (office-scoped; super admin can delete any)."""
    user = await get_current_user(request)
    if not can_use_badges(user):
        raise HTTPException(status_code=403, detail="Badges are for Admins and Coach+ only")
    badge = await db.badges.find_one({"id": badge_id})
    if not badge:
        raise HTTPException(status_code=404, detail="Badge not found")
    if not _can_access_badge(user, badge):
        raise HTTPException(status_code=403, detail="This badge belongs to a different office")
    await db.badges.delete_one({"id": badge_id})
    if badge.get("photo_key"):
        await object_storage.delete(badge["photo_key"])
    return {"message": "Badge deleted"}

