"""Coaching Resources — admin-managed library of training docs and links.

Folders form a tree (parent_id chain). Each resource lives in one folder and
declares which role buckets are allowed to see it. Trainees / Leaders /
Core-leaders / Admins can browse & open / share / print resources visible
to them; only admins can upload, edit, rename, delete.

Audience values (subset of): "admin", "core_leader", "leader", "trainee".
Empty / missing audience → admin-only by default (so accidental uploads
aren't leaked).

Storage: PDFs are stored in MongoDB GridFS (motor AsyncIOMotorGridFSBucket).
GridFS splits files into 255 KB chunks so there is no 16 MB BSON limit.
The resource doc in coaching_resources stores only metadata + gridfs_id.
Legacy records with inline file_b64 are still readable via the fallback
path in get_resource_file.
"""
from __future__ import annotations

import base64
import hashlib
import io
import uuid
from datetime import datetime, timezone
from typing import List, Optional
from urllib.parse import urlparse

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorGridFSBucket
from pydantic import BaseModel, Field

from auth import get_current_user
from database import db
from core.brand import BRITISH_ENGLISH, SELF_EMPLOYED_TERMS
from core.cod_stages import cod_stage_rank, sort_cod_stages


router = APIRouter()


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


VALID_AUDIENCES = {"admin", "core_leader", "leader", "trainee"}


def _is_admin(user: dict) -> bool:
    return user.get("role") == "admin"


def _user_audience_buckets(user: dict) -> List[str]:
    """Return the audience buckets a user belongs to. Admins implicitly
    belong to all so they can see everything."""
    role = user.get("role")
    buckets: List[str] = []
    if role == "admin":
        buckets = ["admin", "core_leader", "leader", "trainee"]
    elif role == "leader":
        buckets = ["leader"]
        if user.get("is_core_leader") or user.get("core_leader"):
            buckets.append("core_leader")
    elif role == "trainee":
        buckets = ["trainee"]
    return buckets


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_audience(raw) -> List[str]:
    if not raw:
        return ["admin"]
    if isinstance(raw, str):
        raw = [raw]
    cleaned = [str(x).strip().lower() for x in raw if isinstance(x, (str, int))]
    cleaned = [x for x in cleaned if x in VALID_AUDIENCES]
    if not cleaned:
        return ["admin"]
    # admin always implicitly included so admins keep visibility on uploads
    if "admin" not in cleaned:
        cleaned.append("admin")
    # de-dupe preserving order
    seen = set(); out = []
    for c in cleaned:
        if c not in seen:
            seen.add(c); out.append(c)
    return out


def _serialize_folder(f: dict) -> dict:
    return {
        "id": f.get("id"),
        "name": f.get("name") or "Untitled",
        "parent_id": f.get("parent_id"),
        "order": int(f.get("order") or 0),
        "created_by_id": f.get("created_by_id"),
        "created_at": f.get("created_at"),
        "updated_at": f.get("updated_at"),
    }


def _serialize_resource(r: dict) -> dict:
    out = {
        "id": r.get("id"),
        "folder_id": r.get("folder_id"),
        "title": r.get("title") or "Untitled",
        "description": r.get("description") or "",
        "type": r.get("type") or "link",        # 'pdf' | 'link'
        "audience": list(r.get("audience") or []),
        "order": int(r.get("order") or 0),
        "created_by_id": r.get("created_by_id"),
        "created_by_name": r.get("created_by_name"),
        "created_at": r.get("created_at"),
        "updated_at": r.get("updated_at"),
    }
    if r.get("type") == "link":
        out["link_url"] = _safe_link(r.get("link_url"))
    else:
        out.update({
            "file_name": r.get("file_name"),
            "file_size": int(r.get("file_size") or 0),
            "mime_type": PDF_MIME,
        })
    return out


def _gridfs() -> AsyncIOMotorGridFSBucket:
    return AsyncIOMotorGridFSBucket(db, bucket_name="coaching_pdfs")


# ──────────────────────────────────────────────────────────────────────────
# Models
# ──────────────────────────────────────────────────────────────────────────


class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[str] = None
    order: int = 0


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[str] = None
    order: Optional[int] = None


class ResourceCreate(BaseModel):
    title: str
    description: str = ""
    folder_id: Optional[str] = None
    type: str = "link"                         # 'pdf' | 'link'
    audience: List[str] = Field(default_factory=lambda: ["admin"])
    order: int = 0
    # PDF (base64 with optional data: prefix)
    file_b64: Optional[str] = None
    file_name: Optional[str] = None
    mime_type: Optional[str] = None
    # Link / YouTube
    link_url: Optional[str] = None


class ResourceUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    folder_id: Optional[str] = None
    audience: Optional[List[str]] = None
    order: Optional[int] = None
    link_url: Optional[str] = None
    # If file_b64 is present, replace the PDF content too.
    file_b64: Optional[str] = None
    file_name: Optional[str] = None
    mime_type: Optional[str] = None


# ──────────────────────────────────────────────────────────────────────────
# Folder endpoints
# ──────────────────────────────────────────────────────────────────────────


@router.get("/coaching/tree")
async def get_tree(request: Request):
    """Return the entire folder + resource tree, filtered to whatever the
    current user is allowed to see. Empty folders (where no resources are
    visible to the user) are hidden for non-admins so the UI stays tidy."""
    user = await get_current_user(request)
    buckets = set(_user_audience_buckets(user))
    is_admin = _is_admin(user)

    folders = [_serialize_folder(f) async for f in db.coaching_folders.find().sort("order", 1)]
    resources = []
    async for r in db.coaching_resources.find().sort([("order", 1), ("title", 1)]):
        aud = set(r.get("audience") or [])
        if not is_admin and aud.isdisjoint(buckets):
            continue
        resources.append(_serialize_resource(r))

    if not is_admin:
        # Build set of folder_ids that have visible resources, then walk
        # parents to keep the path. Hide everything else.
        visible_with_parents: set = set()
        folder_by_id = {f["id"]: f for f in folders}
        for r in resources:
            fid = r.get("folder_id")
            while fid:
                if fid in visible_with_parents:
                    break
                visible_with_parents.add(fid)
                fid = (folder_by_id.get(fid) or {}).get("parent_id")
        folders = [f for f in folders if f["id"] in visible_with_parents]

    return {"folders": folders, "resources": resources}


@router.post("/coaching/folders")
async def create_folder(body: FolderCreate, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Folder name is required")
    if body.parent_id:
        parent = await db.coaching_folders.find_one({"id": body.parent_id})
        if not parent:
            raise HTTPException(status_code=400, detail="Parent folder not found")
    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "parent_id": body.parent_id,
        "order": int(body.order or 0),
        "created_by_id": user.get("id"),
        "created_at": _now(),
        "updated_at": _now(),
    }
    await db.coaching_folders.insert_one(doc)
    return _serialize_folder(doc)


@router.put("/coaching/folders/{folder_id}")
async def update_folder(folder_id: str, body: FolderUpdate, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    set_doc: dict = {"updated_at": _now()}
    if body.name is not None:
        n = body.name.strip()
        if not n:
            raise HTTPException(status_code=400, detail="Folder name cannot be empty")
        set_doc["name"] = n
    if body.parent_id is not None:
        if body.parent_id == folder_id:
            raise HTTPException(status_code=400, detail="Folder cannot be its own parent")
        if body.parent_id:
            parent = await db.coaching_folders.find_one({"id": body.parent_id})
            if not parent:
                raise HTTPException(status_code=400, detail="Parent folder not found")
        set_doc["parent_id"] = body.parent_id
    if body.order is not None:
        set_doc["order"] = int(body.order)
    res = await db.coaching_folders.update_one({"id": folder_id}, {"$set": set_doc})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Folder not found")
    f = await db.coaching_folders.find_one({"id": folder_id})
    return _serialize_folder(f)


@router.delete("/coaching/folders/{folder_id}")
async def delete_folder(folder_id: str, request: Request, recursive: bool = False):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    folder = await db.coaching_folders.find_one({"id": folder_id})
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")

    if not recursive:
        child_count = await db.coaching_folders.count_documents({"parent_id": folder_id})
        res_count = await db.coaching_resources.count_documents({"folder_id": folder_id})
        if child_count or res_count:
            raise HTTPException(
                status_code=400,
                detail="Folder is not empty — pass ?recursive=true to delete children too",
            )
        await db.coaching_folders.delete_one({"id": folder_id})
        return {"ok": True, "deleted": 1}

    # Recursive — gather descendants by BFS
    to_visit = [folder_id]
    all_folders = [folder_id]
    while to_visit:
        parent = to_visit.pop()
        async for c in db.coaching_folders.find({"parent_id": parent}, {"id": 1}):
            all_folders.append(c["id"])
            to_visit.append(c["id"])
    res_del = await db.coaching_resources.delete_many({"folder_id": {"$in": all_folders}})
    fol_del = await db.coaching_folders.delete_many({"id": {"$in": all_folders}})
    return {"ok": True, "folders_deleted": fol_del.deleted_count, "resources_deleted": res_del.deleted_count}


# ──────────────────────────────────────────────────────────────────────────
# Resource endpoints
# ──────────────────────────────────────────────────────────────────────────


PDF_MIME = "application/pdf"
MAX_LINK_LENGTH = 2048


def _require_pdf(raw: bytes) -> bytes:
    """Uploads must really be PDFs: the file is opened on the app's own origin,
    so anything else (an HTML or SVG file labelled as a PDF) could run script
    there. The type is never taken from the client."""
    if not raw.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="That file isn't a PDF. Upload a .pdf file.")
    return raw


def _clean_link(url: str) -> str:
    """Links open in a browser from the app: https only, so a `javascript:`
    or `data:` URL can never be stored."""
    u = (url or "").strip()
    parsed = urlparse(u)
    if (
        len(u) > MAX_LINK_LENGTH
        or parsed.scheme.lower() != "https"
        or not parsed.netloc
        or any(c.isspace() or ord(c) < 32 for c in u)
    ):
        raise HTTPException(status_code=400, detail="Links must be full https:// web addresses.")
    return u


def _safe_link(url) -> Optional[str]:
    """Read side: a stored link that isn't https (from before the rule) is
    withheld rather than served."""
    try:
        return _clean_link(url or "")
    except HTTPException:
        return None


def _decode_b64(b64: str) -> bytes:
    """Strip an optional `data:application/pdf;base64,` prefix and decode."""
    s = (b64 or "").strip()
    if "," in s and s.startswith("data:"):
        s = s.split(",", 1)[1]
    try:
        return base64.b64decode(s, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 file payload")


@router.post("/coaching/resources")
async def create_resource(body: ResourceCreate, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    if body.folder_id:
        f = await db.coaching_folders.find_one({"id": body.folder_id})
        if not f:
            raise HTTPException(status_code=400, detail="Folder not found")

    rtype = (body.type or "link").lower()
    doc: dict = {
        "id": str(uuid.uuid4()),
        "folder_id": body.folder_id,
        "title": title,
        "description": (body.description or "").strip(),
        "type": rtype,
        "audience": _norm_audience(body.audience),
        "order": int(body.order or 0),
        "created_by_id": user.get("id"),
        "created_by_name": user.get("name") or user.get("email"),
        "created_at": _now(),
        "updated_at": _now(),
    }

    if rtype == "pdf":
        if not body.file_b64:
            raise HTTPException(status_code=400, detail="PDF upload requires file_b64")
        raw = _require_pdf(_decode_b64(body.file_b64))
        file_name = (body.file_name or f"{title}.pdf").strip()
        gfs = _gridfs()
        gridfs_id = await gfs.upload_from_stream(file_name, io.BytesIO(raw))
        doc["gridfs_id"] = str(gridfs_id)
        doc["file_name"] = file_name
        doc["file_size"] = len(raw)
        doc["mime_type"] = PDF_MIME
    elif rtype == "link":
        url = (body.link_url or "").strip()
        if not url:
            raise HTTPException(status_code=400, detail="Link URL is required")
        doc["link_url"] = _clean_link(url)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown resource type: {rtype}")

    await db.coaching_resources.insert_one(doc)
    return _serialize_resource(doc)


@router.put("/coaching/resources/{rid}")
async def update_resource(rid: str, body: ResourceUpdate, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    existing = await db.coaching_resources.find_one({"id": rid})
    if not existing:
        raise HTTPException(status_code=404, detail="Resource not found")
    set_doc: dict = {"updated_at": _now()}
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        set_doc["title"] = t
    if body.description is not None:
        set_doc["description"] = body.description.strip()
    if body.folder_id is not None:
        if body.folder_id:
            f = await db.coaching_folders.find_one({"id": body.folder_id})
            if not f:
                raise HTTPException(status_code=400, detail="Folder not found")
        set_doc["folder_id"] = body.folder_id
    if body.audience is not None:
        set_doc["audience"] = _norm_audience(body.audience)
    if body.order is not None:
        set_doc["order"] = int(body.order)
    if body.link_url is not None and existing.get("type") == "link":
        url = body.link_url.strip()
        if not url:
            raise HTTPException(status_code=400, detail="Link URL cannot be empty")
        set_doc["link_url"] = _clean_link(url)
    if body.file_b64 is not None and existing.get("type") == "pdf":
        raw = _require_pdf(_decode_b64(body.file_b64))
        fname = (body.file_name or existing.get("file_name") or f"{rid}.pdf").strip()
        gfs = _gridfs()
        # Delete the old GridFS file if present
        old_gid = existing.get("gridfs_id")
        if old_gid:
            try:
                await gfs.delete(ObjectId(old_gid))
            except Exception:
                pass
        new_gid = await gfs.upload_from_stream(fname, io.BytesIO(raw))
        set_doc["gridfs_id"] = str(new_gid)
        set_doc["file_size"] = len(raw)
        if body.file_name:
            set_doc["file_name"] = body.file_name.strip()
        set_doc["mime_type"] = PDF_MIME
    await db.coaching_resources.update_one({"id": rid}, {"$set": set_doc})
    r = await db.coaching_resources.find_one({"id": rid})
    return _serialize_resource(r)


@router.delete("/coaching/resources/{rid}")
async def delete_resource(rid: str, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    existing = await db.coaching_resources.find_one({"id": rid})
    if not existing:
        raise HTTPException(status_code=404, detail="Resource not found")
    await db.coaching_resources.delete_one({"id": rid})
    gid = existing.get("gridfs_id")
    if gid:
        try:
            await _gridfs().delete(ObjectId(gid))
        except Exception:
            pass
    return {"ok": True}


@router.get("/coaching/resources/{rid}/file")
async def get_resource_file(rid: str, request: Request):
    """Return the PDF payload (base64) for in-app viewing / printing /
    sharing. Audience-checked. Returned as JSON so the mobile app can
    decode and hand it off to expo-file-system / expo-print without
    streaming gymnastics."""
    user = await get_current_user(request)
    r = await db.coaching_resources.find_one({"id": rid})
    if not r:
        raise HTTPException(status_code=404, detail="Resource not found")
    if r.get("type") != "pdf":
        raise HTTPException(status_code=400, detail="Resource is not a PDF")
    buckets = set(_user_audience_buckets(user))
    aud = set(r.get("audience") or [])
    if not _is_admin(user) and aud.isdisjoint(buckets):
        raise HTTPException(status_code=403, detail="Not allowed to view this resource")
    # GridFS (new storage) → fallback to legacy inline base64 in the doc
    gid = r.get("gridfs_id")
    if gid:
        buf = io.BytesIO()
        await _gridfs().download_to_stream(ObjectId(gid), buf)
        file_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    else:
        file_b64 = r.get("file_b64") or ""
    return {
        "id": r["id"],
        "title": r.get("title"),
        "file_name": r.get("file_name"),
        "mime_type": PDF_MIME,
        "file_size": int(r.get("file_size") or 0),
        "file_b64": file_b64,
    }


# ──────────────────────────────────────────────────────────────────────────
# Leadership Hub — structured "Impacts" content (stage-grouped)
#
# A separate, in-app interactive layer of teaching content extracted from
# the Impact Booklet and Leadership Toolkit. Unlike `coaching_resources`
# (flat PDFs / links), each impact is an expandable card with title /
# summary / body / key takeaways, grouped by Stage 1-4. Role-based:
#   • trainee     → stages 1 & 2
#   • leader      → stages 1, 2, 3
#   • core_leader → stages 1, 2, 3, 4
#   • admin       → all stages, plus CRUD
# ──────────────────────────────────────────────────────────────────────────


async def _impact_stages_for_user(user: dict) -> List[int]:
    """Which Leadership Hub stages a user can see.

    Progressive access (COD 2026 stages):
      • Admins              → 1, 2, 3, 4, 5 (SL)
      • Core leaders / SA   → 1, 2, 3, 4, 5
      • Leaders             → 1, 2, 3 — plus 5 (SL) when the SL COD stage
                              is unlocked for them (same gate as the COD).
                              Stage 4 stays team-builder only.
      • Trainees            → Stage 1 always, Stage 2 once unlocked.
                              Stage 3+ is coach/team content, hidden.
    """
    role = user.get("role")
    if role == "admin":
        return [1, 2, 3, 4, 5]
    if role == "leader":
        if user.get("is_core_leader") or user.get("core_leader") or user.get("is_super_admin"):
            return [1, 2, 3, 4, 5]
        stages = [1, 2, 3]
        try:
            from routes.modules import _is_stage_unlocked
            if await _is_stage_unlocked(user, 5):
                stages.append(5)
        except Exception:
            pass
        return stages

    # Trainee path — start with Stage 1 (sales mechanics), unlock Stage 2 progressively.
    # Anyone without a recognised role is treated like a trainee for safety.
    from routes.modules import _is_stage_unlocked  # local import to avoid cycle
    stages = [1]
    try:
        if await _is_stage_unlocked(user, 2):
            stages.append(2)
    except Exception:
        pass
    return stages


def _serialize_impact(d: dict) -> dict:
    return {
        "id": d.get("id"),
        "title": d.get("title") or "Untitled",
        "summary": d.get("summary") or "",
        "body": d.get("body") or "",
        "key_takeaways": list(d.get("key_takeaways") or []),
        "stage": int(d.get("stage") or 1),
        "category": d.get("category") or "general",
        "source": d.get("source") or "",
        "order": int(d.get("order") or 0),
        "created_at": d.get("created_at"),
        "updated_at": d.get("updated_at"),
    }


class ImpactCreate(BaseModel):
    title: str
    summary: str = ""
    body: str = ""
    key_takeaways: List[str] = Field(default_factory=list)
    stage: int = 1
    category: str = "general"
    source: str = ""
    order: int = 0


class ImpactUpdate(BaseModel):
    title: Optional[str] = None
    summary: Optional[str] = None
    body: Optional[str] = None
    key_takeaways: Optional[List[str]] = None
    stage: Optional[int] = None
    category: Optional[str] = None
    source: Optional[str] = None
    order: Optional[int] = None


@router.get("/coaching/impacts")
async def list_impacts(request: Request):
    """Return all impacts visible to the current user, grouped by stage."""
    user = await get_current_user(request)
    # `stages` is a display sequence the hub renders straight through (the
    # stage chips and the section order), so it leaves here in COD display
    # order: 1, 2, 3, SL, 4. SL is STORED as stage 5 and stays 5 — the query
    # filter below is unaffected by the ordering.
    stages = sort_cod_stages(await _impact_stages_for_user(user))
    out: List[dict] = []
    async for d in db.coaching_impacts.find({"stage": {"$in": stages}}).sort([("order", 1), ("title", 1)]):
        out.append(_serialize_impact(d))
    # Stable sort, so the (order, title) run inside each stage is preserved.
    out.sort(key=lambda it: cod_stage_rank(it["stage"]))
    # Group by stage for frontend convenience
    grouped: dict = {str(s): [] for s in stages}
    for it in out:
        grouped.setdefault(str(it["stage"]), []).append(it)
    return {
        "stages": stages,
        "impacts": out,
        "grouped": grouped,
        "is_admin": _is_admin(user),
    }


@router.post("/coaching/impacts")
async def create_impact(body: ImpactCreate, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    stage = int(body.stage)
    if stage not in (1, 2, 3, 4):
        raise HTTPException(status_code=400, detail="Stage must be 1-4")
    doc = {
        "id": str(uuid.uuid4()),
        "title": title,
        "summary": (body.summary or "").strip(),
        "body": (body.body or "").strip(),
        "key_takeaways": [str(s).strip() for s in (body.key_takeaways or []) if s and str(s).strip()],
        "stage": stage,
        "category": (body.category or "general").strip().lower() or "general",
        "source": (body.source or "").strip(),
        "order": int(body.order or 0),
        "created_by_id": user.get("id"),
        "created_at": _now(),
        "updated_at": _now(),
    }
    await db.coaching_impacts.insert_one(doc)
    return _serialize_impact(doc)


@router.put("/coaching/impacts/{impact_id}")
async def update_impact(impact_id: str, body: ImpactUpdate, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    existing = await db.coaching_impacts.find_one({"id": impact_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Impact not found")
    set_doc: dict = {"updated_at": _now()}
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        set_doc["title"] = t
    if body.summary is not None:
        set_doc["summary"] = body.summary.strip()
    if body.body is not None:
        set_doc["body"] = body.body.strip()
    if body.key_takeaways is not None:
        set_doc["key_takeaways"] = [str(s).strip() for s in body.key_takeaways if s and str(s).strip()]
    if body.stage is not None:
        s = int(body.stage)
        if s not in (1, 2, 3, 4):
            raise HTTPException(status_code=400, detail="Stage must be 1-4")
        set_doc["stage"] = s
    if body.category is not None:
        set_doc["category"] = (body.category or "general").strip().lower() or "general"
    if body.source is not None:
        set_doc["source"] = body.source.strip()
    if body.order is not None:
        set_doc["order"] = int(body.order)
    await db.coaching_impacts.update_one({"id": impact_id}, {"$set": set_doc})
    d = await db.coaching_impacts.find_one({"id": impact_id})
    return _serialize_impact(d)


@router.delete("/coaching/impacts/{impact_id}")
async def delete_impact(impact_id: str, request: Request):
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    res = await db.coaching_impacts.delete_one({"id": impact_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Impact not found")
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────
# Impact quizzes — "check your understanding" for Leadership Hub content.
#
# Mirrors routes/modules.py's module-quiz endpoints EXACTLY (same response
# shapes, same Gemini generation path, same content-hash cache pattern) so
# the frontend can reuse the module-quiz UI unchanged. Correct answers never
# leave the server — grading happens here. Cache: coaching_impact_quizzes
# keyed by (impact_id, content_hash), so editing an impact's text
# regenerates its quiz. Pass records land in coaching_impact_quiz_passes
# (best score upserted per user+impact) — NOT on module_progress, because
# coaching content is not a training module.
# ──────────────────────────────────────────────────────────────────────────


async def _check_impact_read(user: dict, d: dict) -> None:
    """Same read gate as list_impacts — raises 403 when the impact's stage
    is not visible to this user's role."""
    stages = await _impact_stages_for_user(user)
    if int(d.get("stage") or 1) not in stages:
        raise HTTPException(status_code=403, detail="Impact not unlocked for your role")


def _impact_quiz_source(d: dict) -> tuple:
    """(content, extra) text an impact quiz is generated from. Body + summary
    are the primary content; key takeaways are the supporting context —
    mirrors modules.py's trainee_content / what_good_looks_like split."""
    parts = [str(d.get("summary") or "").strip(), str(d.get("body") or "").strip()]
    content = "\n\n".join(p for p in parts if p)
    kt = d.get("key_takeaways") or []
    extra = "\n".join(str(x) for x in kt) if isinstance(kt, list) else str(kt)
    return content, extra


def _impact_quiz_hash(d: dict) -> str:
    content, extra = _impact_quiz_source(d)
    return hashlib.sha1((content + "\n" + extra).encode("utf-8")).hexdigest()[:16]


async def _generate_impact_quiz_questions(d: dict, content: str, extra: str) -> Optional[list]:
    """Generate 3 MCQs from an impact's text via the same LLM path as
    routes/modules.py's _get_or_create_quiz. Returns None when generation is
    unavailable (no key, LLM error, unparseable output) — callers 404."""
    import os

    from core.llm_keys import anthropic_api_key
    api_key = anthropic_api_key()
    if not api_key:
        return None
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
    except Exception:
        return None
    chat = LlmChat(
        api_key=api_key,
        session_id=f"impact-quiz-{uuid.uuid4().hex[:10]}",
        system_message="You write short coaching quizzes. Return VALID JSON only — no prose, no code fences. " + BRITISH_ENGLISH + " " + SELF_EMPLOYED_TERMS,
    ).with_model("anthropic")

    prompt = (
        "Create exactly 3 multiple-choice questions testing understanding of this "
        "leadership coaching piece. Rules:\n"
        "- Answerable purely from the text below.\n"
        "- 4 answer choices each, exactly one correct, plausible distractors.\n"
        "- Practical (what would you DO), not trivia about wording.\n"
        'Return JSON: {"questions":[{"question":"...","choices":["a","b","c","d"],"answer":0}]}\n\n'
        f"TOPIC: {d.get('title')}\n\nCONTENT:\n{content[:6000]}\n\n"
        f"KEY TAKEAWAYS:\n{extra[:2000]}"
    )
    try:
        import asyncio
        resp = await asyncio.wait_for(chat.send_message(UserMessage(text=prompt)), timeout=45)
    except Exception:
        return None
    text = resp if isinstance(resp, str) else str(resp)
    cleaned = text.strip()
    import re as _re
    if cleaned.startswith("```"):
        cleaned = _re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = _re.sub(r"\s*```\s*$", "", cleaned)
    if not cleaned.startswith("{"):
        mt = _re.search(r"\{.*\}", cleaned, flags=_re.S)
        if mt:
            cleaned = mt.group(0)
    try:
        import json as _json
        parsed = _json.loads(cleaned)
    except Exception:
        return None

    qs = []
    for q in (parsed.get("questions") or [])[:5]:
        try:
            question = str(q.get("question") or "").strip()
            choices = [str(c).strip() for c in (q.get("choices") or [])][:4]
            answer = int(q.get("answer"))
        except Exception:
            continue
        if question and len(choices) == 4 and 0 <= answer <= 3 and all(choices):
            qs.append({"id": str(uuid.uuid4()), "question": question, "choices": choices, "answer": answer})
    if len(qs) < 3:
        return None
    return qs[:3]


async def _get_or_create_impact_quiz(d: dict, user: Optional[dict] = None) -> Optional[dict]:
    """Cached-quiz lookup keyed by content hash; generate + cache on miss.
    Mirrors modules.py's _get_or_create_quiz for coaching_impacts docs: the
    requesting `user` pays one AI-quota unit for a generation, and a failed
    generation isn't retried for an hour."""
    from core.rate_limit import generation_allowed, generation_started, generation_succeeded, take_ai_quota
    content, extra = _impact_quiz_source(d)
    if len(content) < 60:
        return None
    h = _impact_quiz_hash(d)
    existing = await db.coaching_impact_quizzes.find_one({"impact_id": d["id"], "content_hash": h})
    if existing:
        existing.pop("_id", None)
        return existing
    gen_key = f"impact-quiz:{d['id']}:{h}"
    if not generation_allowed(gen_key):
        return None
    if user is not None:
        take_ai_quota(user)
    generation_started(gen_key)
    qs = await _generate_impact_quiz_questions(d, content, extra)
    if not qs:
        return None
    generation_succeeded(gen_key)
    doc = {
        "id": str(uuid.uuid4()),
        "impact_id": d["id"],
        "content_hash": h,
        "questions": qs,
        "created_at": _now(),
    }
    await db.coaching_impact_quizzes.insert_one(doc.copy())
    doc.pop("_id", None)
    return doc


@router.get("/coaching/impacts/{impact_id}/quiz")
async def get_impact_quiz(impact_id: str, request: Request):
    """Quiz questions for an impact — WITHOUT the correct answers.
    Same response shape as GET /modules/{id}/quiz."""
    user = await get_current_user(request)
    d = await db.coaching_impacts.find_one({"id": impact_id})
    if not d:
        raise HTTPException(status_code=404, detail="Impact not found")
    await _check_impact_read(user, d)
    quiz = await _get_or_create_impact_quiz(d, user)
    if not quiz:
        raise HTTPException(status_code=404, detail="No quiz available for this impact yet")
    return {
        "quiz_id": quiz["id"],
        "questions": [{"id": q["id"], "question": q["question"], "choices": q["choices"]} for q in quiz["questions"]],
    }


class ImpactQuizSubmit(BaseModel):
    quiz_id: str
    answers: dict  # question_id -> chosen choice index


@router.post("/coaching/impacts/{impact_id}/quiz/submit")
async def submit_impact_quiz(impact_id: str, body: ImpactQuizSubmit, request: Request):
    """Grade a quiz attempt server-side. Pass = at least 2 of 3. Same
    request/response shape as POST /modules/{id}/quiz/submit; the pass is
    recorded in coaching_impact_quiz_passes (best score kept per
    user+impact) so the hub can show completed states."""
    user = await get_current_user(request)
    d = await db.coaching_impacts.find_one({"id": impact_id})
    if not d:
        raise HTTPException(status_code=404, detail="Impact not found")
    await _check_impact_read(user, d)
    quiz = await db.coaching_impact_quizzes.find_one({"id": body.quiz_id, "impact_id": impact_id})
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz has been refreshed — reload and try again")

    score = 0
    results = []
    for q in quiz.get("questions") or []:
        try:
            chosen = int((body.answers or {}).get(q["id"], -1))
        except Exception:
            chosen = -1
        ok = chosen == q.get("answer")
        if ok:
            score += 1
        results.append({"id": q["id"], "correct": q.get("answer"), "chosen": chosen, "ok": ok})
    total = len(results)
    passed = total > 0 and score >= max(1, total - 1)

    uid = str(user.get("id") or user.get("_id") or "")
    now = _now()
    existing = await db.coaching_impact_quiz_passes.find_one({"user_id": uid, "impact_id": impact_id})
    if existing:
        upd: dict = {"last_at": now, "total": total}
        if score > int(existing.get("score") or 0):
            upd["score"] = score
        if passed and not existing.get("passed"):
            upd["passed"] = True
            upd["passed_at"] = now
        await db.coaching_impact_quiz_passes.update_one({"_id": existing["_id"]}, {"$set": upd})
    else:
        await db.coaching_impact_quiz_passes.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": uid,
            "impact_id": impact_id,
            "score": score,
            "total": total,
            "passed": passed,
            "passed_at": now if passed else None,
            "last_at": now,
        })
    return {"score": score, "total": total, "passed": passed, "results": results}


@router.get("/coaching/impacts/{impact_id}/quiz-state")
async def get_impact_quiz_state(impact_id: str, request: Request):
    """The current user's best quiz result for an impact — the hub's
    progress chips. Cheap find_one; never generates anything."""
    user = await get_current_user(request)
    uid = str(user.get("id") or user.get("_id") or "")
    row = await db.coaching_impact_quiz_passes.find_one({"user_id": uid, "impact_id": impact_id})
    if not row:
        return {"passed": False, "score": None, "total": None, "passed_at": None}
    return {
        "passed": bool(row.get("passed")),
        "score": row.get("score"),
        "total": row.get("total"),
        "passed_at": row.get("passed_at"),
    }


@router.get("/coaching/usage")
async def usage(request: Request):
    """Total bytes used by coaching resources (admin badge)."""
    user = await get_current_user(request)
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin access required")
    pipeline = [
        {"$group": {
            "_id": None,
            "total_bytes": {"$sum": {"$ifNull": ["$file_size", 0]}},
            "pdf_count": {"$sum": {"$cond": [{"$eq": ["$type", "pdf"]}, 1, 0]}},
            "link_count": {"$sum": {"$cond": [{"$eq": ["$type", "link"]}, 1, 0]}},
        }}
    ]
    out = {"total_bytes": 0, "pdf_count": 0, "link_count": 0, "folder_count": 0}
    async for row in db.coaching_resources.aggregate(pipeline):
        out["total_bytes"] = int(row.get("total_bytes") or 0)
        out["pdf_count"] = int(row.get("pdf_count") or 0)
        out["link_count"] = int(row.get("link_count") or 0)
    out["folder_count"] = await db.coaching_folders.count_documents({})
    # MongoDB Atlas free tier is 512 MB. Assume similar default cap; UI
    # converts to MB and shows a percent. Cap is a soft hint only.
    out["soft_cap_bytes"] = 512 * 1024 * 1024
    return out
