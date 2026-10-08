"""A BA's day in the field, hour by hour — the sums behind the Timeline.

OwnerIQ's Live Operations keeps each BA's door log for a day: every door, the
time it was knocked and how it ended, grouped into laps of the sector. The
nightly re-settle saves that log (owneriq_live_cache). Everything here is
worked out from it, with no database, so it can be tested on its own:

  summarise_ba_day   one day's log → a small record: sign-ups and doors for
                     each hour of the day (UK time), first and last door, time
                     in the field, and the SECTOR BREAK: from the last door of
                     the first lap to the first door of the second.
  timeline           many of those records → the office's (or a team's, or one
                     person's) sign-ups by hour, and each BA's own hours.
  patterns           person-weeks ranked by sign-ups and split into best,
                     average and low weeks, with what the days in each looked
                     like (first door, last door, time in the field, break…).

A sign-up is a door that ended `won`. The hour is the hour the door was
knocked, in the app's timezone.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Iterable, Optional

from core.app_time import APP_TZ

# How a door ended, as far as the funnel got.
_SPOKEN = {"spoken", "pitching", "pitched"}
_PITCHED = {"pitching", "pitched"}
HERO = ("doors_knocked", "spoken_to", "pitches_commenced", "pitches_closed", "sales", "points")


def _local(ts) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(APP_TZ)
    except ValueError:
        return None


def _minute(t: Optional[datetime]) -> Optional[int]:
    return t.hour * 60 + t.minute if t else None


def week_ending_of(iso_date: str) -> str:
    """The Sunday that ends the bells week a date falls in."""
    d = date.fromisoformat(iso_date)
    return (d + timedelta(days=6 - d.weekday())).isoformat()


def summarise_ba_day(payload: dict, iso_date: str) -> Optional[dict]:
    """One BA's day from OwnerIQ's `live_operations/bas/{id}` payload, or None
    when they knocked no doors that day."""
    ba = payload.get("ba") or {}
    hero = payload.get("hero") or {}
    if ba.get("id") is None:
        return None
    hours: dict[str, dict] = {}
    laps: list[dict] = []
    for lap in payload.get("laps") or []:
        times: list[datetime] = []
        lap_sales = 0
        for address in lap.get("interactions_by_address") or []:
            for door in address.get("interactions") or []:
                t = _local(door.get("created_at"))
                if not t:
                    continue            # a door on the list that was never knocked
                times.append(t)
                cell = hours.setdefault(str(t.hour), {"doors": 0, "spoken": 0, "pitched": 0, "sales": 0})
                cell["doors"] += 1
                state, how = door.get("state"), door.get("lost_state")
                won = state == "won"
                if won or state == "partially_won" or how in _SPOKEN:
                    cell["spoken"] += 1
                if won or state == "partially_won" or how in _PITCHED:
                    cell["pitched"] += 1
                if won:
                    cell["sales"] += 1
                    lap_sales += 1
        if times:
            laps.append({"n": lap.get("number"), "first_min": _minute(min(times)), "last_min": _minute(max(times)),
                         "doors": len(times), "sales": lap_sales})
    first = _local(hero.get("first_knock_at"))
    last = _local(hero.get("last_knock_at"))
    first_min = _minute(first) if first else (min((l["first_min"] for l in laps), default=None))
    last_min = _minute(last) if last else (max((l["last_min"] for l in laps), default=None))
    if first_min is None and not (hero.get("doors_knocked") or 0):
        return None
    laps.sort(key=lambda l: (l["first_min"], l["n"] or 0))
    # The sector break: last door of the first lap → first door of the second.
    break_minutes = None
    if len(laps) >= 2:
        gap = laps[1]["first_min"] - laps[0]["last_min"]
        break_minutes = gap if gap > 0 else 0
    return {
        "oid": str(ba["id"]),
        "date": iso_date,
        "week_ending": week_ending_of(iso_date),
        "name": ba.get("full_name") or "",
        "stage": ba.get("stage"),
        "sector_id": (payload.get("sector") or {}).get("id"),
        "sector_name": (payload.get("sector") or {}).get("name"),
        **{k: int(hero.get(k) or 0) for k in HERO},
        "first_min": first_min,
        "last_min": last_min,
        "field_minutes": (last_min - first_min) if first_min is not None and last_min is not None else None,
        "break_minutes": break_minutes,
        "laps": laps,
        "hours": hours,
    }


def _avg(values: Iterable) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


def timeline(days: list[dict]) -> dict:
    """Sign-ups and doors by hour across `days`, and each BA's own hours."""
    by_hour: dict[int, dict] = {}
    people: dict[str, dict] = {}
    for d in days:
        p = people.setdefault(d["oid"], {"oid": d["oid"], "name": d.get("name") or "", "days": 0, "sales": 0, "doors": 0,
                                         "spoken": 0, "field_minutes": 0, "hours": {}})
        if d.get("name"):
            p["name"] = d["name"]
        p["days"] += 1
        p["sales"] += d.get("sales") or 0
        p["doors"] += d.get("doors_knocked") or 0
        p["spoken"] += d.get("spoken_to") or 0
        p["field_minutes"] += d.get("field_minutes") or 0
        for h, cell in (d.get("hours") or {}).items():
            hour = int(h)
            agg = by_hour.setdefault(hour, {"hour": hour, "sales": 0, "doors": 0, "spoken": 0, "pitched": 0, "ba_hours": 0, "people": set()})
            for k in ("sales", "doors", "spoken", "pitched"):
                agg[k] += cell.get(k) or 0
            agg["ba_hours"] += 1          # one BA out for (part of) this hour, on one day
            agg["people"].add(d["oid"])
            mine = p["hours"].setdefault(str(hour), {"sales": 0, "doors": 0, "n": 0})
            mine["sales"] += cell.get("sales") or 0
            mine["doors"] += cell.get("doors") or 0
            mine["n"] += 1
    hours = []
    if by_hour:
        for hour in range(min(by_hour), max(by_hour) + 1):
            a = by_hour.get(hour) or {"hour": hour, "sales": 0, "doors": 0, "spoken": 0, "pitched": 0, "ba_hours": 0, "people": set()}
            hours.append({"hour": hour, "sales": a["sales"], "doors": a["doors"], "spoken": a["spoken"], "pitched": a["pitched"],
                          "ba_hours": a["ba_hours"], "people": len(a["people"]),
                          # sign-ups for every BA-hour worked in this hour: the hour's productivity
                          "per_ba_hour": round(a["sales"] / a["ba_hours"], 2) if a["ba_hours"] else 0})
    bas = []
    for p in people.values():
        best = max(p["hours"].items(), key=lambda kv: (kv[1]["sales"], kv[1]["doors"]), default=None)
        field_hours = round(p["field_minutes"] / 60, 1)
        bas.append({**p, "field_hours": field_hours,
                    "per_hour": round(p["sales"] / field_hours, 2) if field_hours else None,
                    "best_hour": int(best[0]) if best and best[1]["sales"] > 0 else None})
        bas[-1].pop("field_minutes")
    bas.sort(key=lambda b: (-b["sales"], -(b["per_hour"] or 0), b["name"].lower()))
    peak = max(hours, key=lambda h: (h["sales"], h["doors"]), default=None)
    return {
        "hours": hours,
        "peak_hour": peak["hour"] if peak and peak["sales"] > 0 else None,
        "bas": bas,
        "totals": {"sales": sum(d.get("sales") or 0 for d in days), "doors": sum(d.get("doors_knocked") or 0 for d in days),
                   "ba_days": len(days), "people": len(people)},
        "averages": _day_averages(days),
    }


def _day_averages(days: list[dict]) -> dict:
    """What a day in the field looked like, averaged over BA-days."""
    return {
        "first_min": _avg(d.get("first_min") for d in days),
        "last_min": _avg(d.get("last_min") for d in days),
        "field_minutes": _avg(d.get("field_minutes") for d in days),
        "break_minutes": _avg(d.get("break_minutes") for d in days),
        "doors": _avg(d.get("doors_knocked") for d in days),
        "spoken": _avg(d.get("spoken_to") for d in days),
        "sales": _avg(d.get("sales") for d in days),
    }


def patterns(days: list[dict]) -> dict:
    """Best, average and low weeks, and what the days in each looked like.

    A "week" is one person's week (their BA-days sharing a week_ending). The
    weeks are ranked by sign-ups and cut into thirds: the top third are the
    best weeks, the bottom third the low ones. With fewer than three weeks
    there is nothing to rank into thirds: the best week and the worst week
    stand for themselves and "average" is all of them."""
    weeks: dict[tuple, list[dict]] = {}
    for d in days:
        weeks.setdefault((d["oid"], d["week_ending"]), []).append(d)
    ranked = sorted(weeks.values(), key=lambda ds: (-sum(x.get("sales") or 0 for x in ds), -len(ds)))
    n = len(ranked)
    if n == 0:
        return {"weeks": 0, "bands": []}
    if n < 3:
        groups = [("best", ranked[:1]), ("average", ranked), ("low", ranked[-1:] if n > 1 else [])]
    else:
        k = max(1, n // 3)
        groups = [("best", ranked[:k]), ("average", ranked[k:n - k] or ranked), ("low", ranked[n - k:])]
    labels = {"best": "Best weeks", "average": "Average weeks", "low": "Low weeks"}
    bands = []
    for key, group in groups:
        if not group:
            continue
        totals = [sum(x.get("sales") or 0 for x in ds) for ds in group]
        flat = [x for ds in group for x in ds]
        bands.append({
            "key": key, "label": labels[key], "weeks": len(group),
            "sales_min": min(totals), "sales_max": max(totals),
            "sales_per_week": round(sum(totals) / len(group), 1),
            "days_per_week": round(len(flat) / len(group), 1),
            **_day_averages(flat),
        })
    return {"weeks": n, "bands": bands}
