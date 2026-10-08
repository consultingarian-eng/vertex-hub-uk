"""Full-database export for migration (super-admin only).

Why this exists: a hosted Mongo can be network-locked so that mongodump from
outside is impossible, while this backend can always read it. This route
streams every collection out as gzipped NDJSON so the data can be backed up or
restored into another Mongo.

Format (one JSON object per line, MongoDB Extended JSON so ObjectId/Date
round-trip losslessly):
  {"__meta__": {"db": …, "collections": N, "exported_at": …}}
  {"__collection__": "users", "count": 123}
  {"c": "users", "d": {…document…}}
  … repeated per collection …

Read-only; safe to leave deployed (it's behind require_super_admin).
"""
import zlib
import logging
from datetime import datetime, timezone

from bson import json_util
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from auth import require_super_admin
from database import db

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/admin/db-export")
async def db_export(request: Request):
    await require_super_admin(request)

    async def gen():
        # gzip container so plain `gunzip` / gzip.open() can read the file
        gz = zlib.compressobj(9, zlib.DEFLATED, 16 + zlib.MAX_WBITS)

        async def emit(line: str):
            return gz.compress((line + "\n").encode("utf-8"))

        names = sorted(await db.list_collection_names())
        names = [n for n in names if not n.startswith("system.")]
        meta = {"__meta__": {
            "db": db.name,
            "collections": len(names),
            "exported_at": datetime.now(timezone.utc).isoformat(),
        }}
        yield await emit(json_util.dumps(meta))

        total = 0
        for name in names:
            count = await db[name].estimated_document_count()
            yield await emit(json_util.dumps({"__collection__": name, "count": count}))
            async for doc in db[name].find({}):
                yield await emit(json_util.dumps({"c": name, "d": doc}))
                total += 1
        logger.info("db-export streamed %d docs across %d collections", total, len(names))
        tail = gz.flush()
        if tail:
            yield tail

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        gen(),
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="cg1-dump-{ts}.ndjson.gz"'},
    )
