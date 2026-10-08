"""The sums behind one person's breakdown page (routes/people.py).

Kept free of the database so they can be tested on their own:

  • law_of_averages — one person's door numbers over a range: totals, the
    average per day in the field, how each step converts into the next, and
    how many of each it takes to get one sign-up.
  • cod_position   — where someone is in the Cycle of Development: marked off
    and total per stage, in COD order, and the stage they are working on.
  • stage_label    — OwnerIQ's "stage_3_plus" (or a plain 3) the way OwnerIQ
    shows it: "3+", "3".
"""
from __future__ import annotations

from typing import Iterable, Optional

from core.cod_stages import COD_STAGE_ORDER

# Doors → sign-ups, in the order they happen on the doors.
FUNNEL = ("doors_knocked", "spoken_to", "pitches_commenced", "pitches_closed", "sales")
METRICS = FUNNEL + ("points",)

COD_STAGE_NAME = {1: "Foundation", 2: "Self Management", 3: "Leader", 4: "Team Builder", 5: "Sector/Site Leader"}


def cod_stage_label(stage: int) -> str:
    """Stage SL is stored as 5 (core/cod_stages.py)."""
    return "SL" if stage == 5 else str(stage)


def stage_label(value) -> Optional[str]:
    """The person's stage as OwnerIQ words it. Only the number is shown, never
    a name: COD stage names don't line up with OwnerIQ's ladder above Stage 4
    (the COD stores Sector/Site Leader as 5; OwnerIQ's 5 is Assistant Owner)."""
    if value is None:
        return None
    text = str(value).strip().lower()
    digits = "".join(ch for ch in text if ch.isdigit())
    if not digits or not 1 <= int(digits) <= 9:
        return None
    return f"{int(digits)}+" if text.endswith("plus") or text.endswith("+") else str(int(digits))


def _pct(part: float, whole: float) -> Optional[int]:
    return round(part / whole * 100) if whole else None


def law_of_averages(rows: Iterable[dict]) -> dict:
    """Totals, average per active day, step-to-step conversion and
    "how many to one sign-up" for one person's daily rows. A day with no
    door activity at all is a day off, not a zero: it isn't averaged in."""
    totals = {m: 0 for m in METRICS}
    by_date: dict[str, dict] = {}
    for r in rows:
        day = by_date.setdefault(str(r.get("date") or ""), {m: 0 for m in METRICS})
        for m in METRICS:
            v = r.get(m) or 0
            day[m] += v
            totals[m] += v
    active = sum(1 for d in by_date.values() if any(d[m] for m in FUNNEL))
    avg = {m: (round(totals[m] / active, 1) if active else 0) for m in METRICS}
    sales = totals["sales"]
    steps = []
    for a, b in zip(FUNNEL, FUNNEL[1:]):
        steps.append({"from": a, "to": b, "pct": _pct(totals[b], totals[a])})
    return {
        "active_days": active,
        "totals": totals,
        "avg_per_day": avg,
        "steps": steps,
        "to_one_sale": {m: (round(totals[m] / sales, 1) if sales else None) for m in FUNNEL[:-1]},
    }


def cod_position(marked: dict[int, int], totals: dict[int, int], met: Optional[dict[int, int]] = None) -> dict:
    """`marked` = modules a Coach has marked off per stage, `totals` = live
    modules per stage, `met` = modules that have reached the standard. The
    stage being worked on is the first, in COD order, that isn't fully marked
    off; None when every stage with content is."""
    stages = []
    current = None
    for stage in COD_STAGE_ORDER:
        total = int(totals.get(stage) or 0)
        if not total:
            continue
        done = min(total, int(marked.get(stage) or 0))
        row = {
            "stage": stage,
            "label": cod_stage_label(stage),
            "name": COD_STAGE_NAME.get(stage, f"Stage {cod_stage_label(stage)}"),
            "done": done,
            "met": min(total, int((met or {}).get(stage) or 0)),
            "total": total,
            "complete": done >= total,
        }
        if current is None and not row["complete"]:
            current = stage
        stages.append(row)
    for row in stages:
        row["current"] = row["stage"] == current
    return {"current_stage": current, "stages": stages}
