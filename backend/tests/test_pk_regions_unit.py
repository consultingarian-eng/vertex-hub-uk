"""Product-knowledge region scoping: content tagged for another region must
never reach an office in a different region (exam pool and topic library),
while untagged docs and ["all"] docs stay visible everywhere. These tests pin
the office→region rule (an optional `region` field on the office) and the
Mongo filter's semantics.
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes.product_knowledge import _office_region, _region_filter  # noqa: E402


# ── Office → region ───────────────────────────────────────────────────────

def test_office_region_field_is_used_when_set():
    assert _office_region({"name": "North Office", "region": "north"}) == "north"
    assert _office_region({"region": "  south  "}) == "south"


def test_office_without_region_falls_back_to_all():
    # Fail-safe: an office with no region sees only shared content.
    assert _office_region({"name": "Head Office"}) == "all"
    assert _office_region({"region": ""}) == "all"
    assert _office_region(None) == "all"


# ── Filter semantics (evaluated with a minimal Mongo-operator matcher) ────

def _field_match(doc, key, cond):
    exists = key in doc
    val = doc.get(key)
    if isinstance(cond, dict) and any(k.startswith("$") for k in cond):
        for op, arg in cond.items():
            if op == "$in":
                ok = any(v in arg for v in val) if isinstance(val, list) else val in arg
            elif op == "$exists":
                ok = exists == bool(arg)
            else:
                raise NotImplementedError(op)
            if not ok:
                return False
        return True
    return val == cond


def _match(doc, flt):
    for k, cond in (flt or {}).items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in cond):
                return False
        elif not _field_match(doc, k, cond):
            return False
    return True


def test_region_filter_hides_other_regions_and_keeps_all_and_untagged():
    flt = _region_filter("north")
    assert _match({"regions": ["north"]}, flt)
    assert _match({"regions": ["all"]}, flt)
    assert _match({}, flt)  # untagged == visible everywhere
    assert not _match({"regions": ["south"]}, flt)


def test_region_filter_is_symmetric():
    flt = _region_filter("south")
    assert _match({"regions": ["south"]}, flt)
    assert _match({"regions": ["all"]}, flt)
    assert not _match({"regions": ["north"]}, flt)


def test_office_without_region_sees_only_shared_content():
    flt = _region_filter("all")
    assert _match({"regions": ["all"]}, flt)
    assert _match({}, flt)
    assert not _match({"regions": ["north"]}, flt)
