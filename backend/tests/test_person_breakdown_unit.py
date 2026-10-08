"""The person page's sums: law of averages, COD position, stage parsing."""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.person_breakdown import cod_position, law_of_averages, stage_label  # noqa: E402


def _day(date, doors, spoken, pitched, closed, sales, points=0):
    return {"date": date, "doors_knocked": doors, "spoken_to": spoken, "pitches_commenced": pitched,
            "pitches_closed": closed, "sales": sales, "points": points}


def test_law_of_averages_skips_days_off_and_converts_each_step():
    out = law_of_averages([
        _day("2026-10-05", 100, 40, 10, 8, 2),
        _day("2026-10-06", 60, 20, 10, 2, 0),
        _day("2026-10-07", 0, 0, 0, 0, 0),          # a day off: not averaged in
    ])
    assert out["active_days"] == 2
    assert out["totals"]["doors_knocked"] == 160 and out["totals"]["sales"] == 2
    assert out["avg_per_day"]["doors_knocked"] == 80 and out["avg_per_day"]["sales"] == 1
    assert [s["pct"] for s in out["steps"]] == [38, 33, 50, 20]
    assert out["to_one_sale"] == {"doors_knocked": 80, "spoken_to": 30, "pitches_commenced": 10, "pitches_closed": 5}


def test_law_of_averages_adds_two_rows_for_the_same_day_and_survives_nothing():
    out = law_of_averages([_day("2026-10-05", 50, 20, 5, 4, 1), _day("2026-10-05", 50, 20, 5, 4, 1)])
    assert out["active_days"] == 1 and out["avg_per_day"]["doors_knocked"] == 100
    empty = law_of_averages([])
    assert empty["active_days"] == 0 and empty["avg_per_day"]["sales"] == 0
    assert empty["to_one_sale"]["doors_knocked"] is None and empty["steps"][0]["pct"] is None


def test_cod_position_walks_the_cod_order_with_sl_before_stage_4():
    out = cod_position({1: 16, 2: 5, 5: 2}, {1: 16, 2: 16, 3: 17, 4: 16, 5: 19}, {2: 9})
    assert [s["stage"] for s in out["stages"]] == [1, 2, 3, 5, 4]
    assert [s["label"] for s in out["stages"]] == ["1", "2", "3", "SL", "4"]
    assert out["current_stage"] == 2
    two = next(s for s in out["stages"] if s["stage"] == 2)
    assert two["done"] == 5 and two["met"] == 9 and two["current"] and not two["complete"]
    assert next(s for s in out["stages"] if s["stage"] == 1)["complete"]


def test_cod_position_caps_at_the_total_and_drops_empty_stages():
    out = cod_position({1: 30}, {1: 16, 2: 0})
    assert out["stages"] == [{"stage": 1, "label": "1", "name": "Foundation", "done": 16, "met": 0, "total": 16,
                              "complete": True, "current": False}]
    assert out["current_stage"] is None


def test_stage_label_reads_owneriq_and_plain_values():
    assert stage_label("stage_3") == "3"
    assert stage_label("stage_3_plus") == "3+"
    assert stage_label(2) == "2"
    assert stage_label(None) is None and stage_label("leader") is None and stage_label("stage_0") is None
