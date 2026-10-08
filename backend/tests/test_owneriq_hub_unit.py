"""Performance Hub: week snapping, freshness, and serving the last copy when
OwnerIQ can't be asked."""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import owneriq_hub  # noqa: E402


class _Coll:
    def __init__(self):
        self.docs = {}

    async def find_one(self, q, *a, **k):
        if "_id" in q:
            return self.docs.get(q["_id"])
        rows = [d for d in self.docs.values() if all(d.get(key) == v for key, v in q.items())]
        return sorted(rows, key=lambda d: d.get("week_start", ""), reverse=True)[0] if rows else None

    async def update_one(self, q, upd, upsert=False):
        d = self.docs.setdefault(q["_id"], {"_id": q["_id"]})
        d.update(upd["$set"])


class _DB:
    def __init__(self):
        self.owneriq_hub = _Coll()
        self.owneriq_sync_state = _Coll()


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


def test_week_snaps_to_monday():
    assert owneriq_hub.clean_week("2026-10-07") == "2026-10-05"
    assert owneriq_hub.clean_week("2026-10-05") == "2026-10-05"
    assert owneriq_hub.clean_week("not-a-date") == owneriq_hub.clean_week(None)
    weeks = owneriq_hub.week_options(3)
    assert [w["label"] for w in weeks] == ["This week", "Last week", None]
    assert weeks[0]["week_start"] == owneriq_hub.clean_week(None)


def test_paths_match_owneriq():
    assert owneriq_hub._path("mc", "39").endswith("/marketing_companies/39")
    assert owneriq_hub._path("team", "61").endswith("/teams/61")
    assert owneriq_hub._path("no_team", "39").endswith("/marketing_companies/39/no_team")


def test_serves_copy_and_flags_stale_without_a_login(monkeypatch):
    db = _DB()
    monkeypatch.setattr(owneriq_hub, "db", db)
    monkeypatch.delenv("OWNERIQ_EMAIL", raising=False)
    monkeypatch.delenv("OWNERIQ_PASSWORD", raising=False)
    ws = owneriq_hub.clean_week(None)
    assert _run(owneriq_hub.get_view("mc", "39", ws)) is None           # nothing yet
    _run(owneriq_hub.store("mc", "39", ws, {"kpis": {"sales": {"value": 18}}}))
    fresh = _run(owneriq_hub.get_view("mc", "39", ws))
    assert fresh["kpis"]["sales"]["value"] == 18 and fresh["stale"] is False
    db.owneriq_hub.docs[f"mc:39:{ws}"]["fetched_at"] = datetime.now(timezone.utc) - timedelta(hours=2)
    old = _run(owneriq_hub.get_view("mc", "39", ws))
    assert old["stale"] is True and old["kpis"]["sales"]["value"] == 18
    assert _run(owneriq_hub.company_id()) == "39"                        # from the seeded copy
