"""The bundled campaign-knowledge playbook (seed/product_knowledge_topics.json):
shape the Product Knowledge routes read, Vertex's own category order, the
compliance scripts kept word-for-word, no personal data, and a fresh
database actually receiving it through seed_loader.
Pure in-memory: mongomock, no network.
"""
import asyncio
import json
import re
import sys
from pathlib import Path

from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import seed_loader  # noqa: E402
from routes.product_knowledge import _ser_topic  # noqa: E402

SEED = BACKEND_DIR / "seed" / "product_knowledge_topics.json"
CATEGORY_ORDER = [
    "The Beginning", "Week One Impact", "Quality", "Cycle of Development",
    "Campaign & compliance", "Pay & progression", "Other",
]


def _topics():
    return json.loads(SEED.read_text(encoding="utf-8"))


def test_every_topic_has_the_fields_the_routes_read():
    topics = _topics()
    assert len(topics) >= 30
    for t in topics:
        for key in ("id", "slug", "title", "category", "summary", "body", "key_facts",
                    "source_url", "order", "created_at", "updated_at"):
            assert key in t, (t.get("slug"), key)
        assert t["title"].strip() and t["body"].strip()
        assert isinstance(t["key_facts"], list)
        ser = _ser_topic(t)
        assert ser["regions"] == ["all"]
    assert len({t["id"] for t in topics}) == len(topics)
    assert len({t["slug"] for t in topics}) == len(topics)


def test_categories_follow_vertex_order_and_order_is_contiguous():
    topics = sorted(_topics(), key=lambda t: t["order"])
    assert [t["order"] for t in topics] == list(range(1, len(topics) + 1))
    seen = []
    for t in topics:
        assert t["category"] in CATEGORY_ORDER, t["category"]
        if not seen or seen[-1] != t["category"]:
            assert t["category"] not in seen, f"{t['category']} is split up"
            seen.append(t["category"])
    assert seen == [c for c in CATEGORY_ORDER if c in seen]
    assert seen[:4] == ["The Beginning", "Week One Impact", "Quality", "Cycle of Development"]


def test_compliance_scripts_are_word_for_word():
    by = {t["slug"]: t["body"] for t in _topics()}
    assert (
        "I am a paid professional fundraiser working on behalf of Acwyre who has been appointed by "
        "the National Deaf Children's Society as part of a campaign to inform the public about the "
        "support deaf children need and to recruit regular and committed supporters."
    ) in by["pre-allocated-fundraising-budget"]
    assert "NDCS has asked us to tell donors to use any high street banks such as Lloyds, Santander" \
        in by["step-5-rehash"]
    assert "Start date: 1st / 8th / 15th / 22nd" in by["step-5-rehash"]
    assert "020 4587 3738" in by["welcome-call"]
    assert "If in doubt, do not sign them up — ask your team leader." in by["who-not-to-sign-up"]
    assert "usually £12 a month for 12–18 months" in by["closing-with-clarity"]


def test_no_extractor_notes_or_personal_data():
    blob = SEED.read_text(encoding="utf-8")
    assert "<!--" not in blob
    assert not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", blob), "an email address slipped in"
    assert "wa.me" not in blob
    # The only phone number in the playbook is the charity's Welcome Call line.
    phones = set(re.findall(r"\b0\d{2,4} ?\d{3,4} ?\d{3,4}\b", blob))
    assert phones <= {"020 4587 3738"}, phones


def test_threshold_only_seeds_an_empty_collection():
    thresholds = dict(seed_loader.COLLECTIONS)
    assert thresholds["product_knowledge_topics"] == 1


def test_fresh_database_receives_the_playbook(monkeypatch):
    monkeypatch.delenv("DISABLE_SEED_LOADER", raising=False)
    db = AsyncMongoMockClient()["pk_seed_test"]

    async def go():
        await seed_loader.load_bundled_seeds(db)
        n = await db.product_knowledge_topics.count_documents({})
        first = await db.product_knowledge_topics.find_one({"order": 1})
        # A second boot must not wipe or duplicate anything.
        await db.product_knowledge_topics.update_one({"id": first["id"]}, {"$set": {"title": "Edited"}})
        await seed_loader.load_bundled_seeds(db)
        again = await db.product_knowledge_topics.count_documents({})
        edited = await db.product_knowledge_topics.find_one({"id": first["id"]})
        return n, again, edited["title"]

    n, again, title = asyncio.run(go())
    assert n == len(_topics())
    assert again == n
    assert title == "Edited"
