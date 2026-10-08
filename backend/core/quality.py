"""Fundraising quality — the charity's FR KPI report (Power BI), per BA.

The client reports quality in Power BI ("FR KPI Report (all charities)"). A
report is imported per office per month (period "YYYY-MM") from its tables:

  overall        per-BA: sign-ups, average donation, completed call rate,
                 wrong number rate, fail rate, average / modal supporter age,
                 % Gift Aid, % phone / email opt-in, no show, 3rd payment %,
                 neo bank %
  kpis-over-wes  per-BA completed call rate for each week ending
  fail-rate      per-BA total sales / fail count, plus fail reasons
  no-show        per-BA net sign-ups / no show rate

Each table's first column is the row label: the charity/agency/office rollup
rows, then one row per BA as "First L BADGE" (e.g. "Faruq O FR6283"), then
"Total". RAG bands mirror the report's own conditional formatting.
"""
from __future__ import annotations

import re

# key, the report's column header, value kind
OVERALL_COLUMNS = [
    ("signups", "Count of sign ups", "int"),
    ("avg_donation", "Average Donation Amount", "money"),
    ("completed_call_rate", "Completed call rate", "pct"),
    ("wrong_number_rate", "Wrong Number Rate", "pct"),
    ("fail_rate", "Fail rate", "pct"),
    ("avg_age", "Average of age", "num"),
    ("age_group", "Mode of Age group of Supporter", "text"),
    ("gift_aid", "% Gift Aid", "pct"),
    ("phone_opt_in", "% Phone opt in", "pct"),
    ("email_opt_in", "% Email opt in", "pct"),
    ("no_show", "No Show", "pct"),
    ("third_payment", "3rd payment %", "pct"),
    ("neo_bank", "Neo bank %", "pct"),
]

LABELS = {k: h for k, h, _ in OVERALL_COLUMNS}
LABELS.update({"completed_call_rate": "Completed call rate (Welcome Calls)", "no_show": "No show rate",
               "age_group": "Most common supporter age group"})

# Green / amber / red, as the report colours them. (low, high) = green at or
# above `green`, amber at or above `amber`, red below; `lower_is_better` flips.
RAG = {
    "completed_call_rate": {"green": 65, "amber": 60},
    "gift_aid": {"green": 90, "amber": 80},
    "phone_opt_in": {"green": 90, "amber": 70},
    "email_opt_in": {"green": 85, "amber": 70},
    "avg_age": {"green": 45, "amber": 35},
    "fail_rate": {"green": 0, "amber": 4, "lower_is_better": True},
    "no_show": {"green": 14.99, "amber": 20, "lower_is_better": True},
    "wrong_number_rate": {"green": 0.99, "amber": 0.99, "lower_is_better": True},
}
GREEN_AGE_GROUPS = {"43-54", "55-66"}

ROLLUP_LABELS = {"total", "bdch", "door2door"}
BADGE_RE = re.compile(r"\s([A-Z]{0,3}\d{3,})$")


def rag(key: str, value) -> str | None:
    if key == "age_group":
        return None if not value else ("green" if str(value).strip() in GREEN_AGE_GROUPS else "amber")
    rule = RAG.get(key)
    if rule is None or value is None:
        return None
    if rule.get("lower_is_better"):
        return "green" if value <= rule["green"] else ("amber" if value <= rule["amber"] else "red")
    return "green" if value >= rule["green"] else ("amber" if value >= rule["amber"] else "red")


def parse_value(text: str, kind: str):
    t = (text or "").strip().replace(",", "").replace("£", "")
    if kind == "text":
        return t or None
    if not t or t.upper() == "N/A":
        return None
    m = re.match(r"^-?\d+(\.\d+)?", t)
    if not m:
        return None
    v = float(m.group(0))
    return int(v) if kind == "int" else round(v, 2)


def badge_of(label: str) -> str | None:
    m = BADGE_RE.search((label or "").strip())
    return m.group(1).upper() if m else None


def _text_rows(grid) -> list[list[str]]:
    """A table as rows of cell text. Accepts plain lists of strings or the
    Power BI capture format (cells as {"t": text, "bg": colour})."""
    rows = grid.get("rows") if isinstance(grid, dict) else grid
    return [[(c.get("t") if isinstance(c, dict) else str(c or "")).strip() for c in r] for r in rows or []]


def _ba_rows(rows: list[list[str]]):
    """(label, badge, cells) for the BA rows of a table, skipping rollups."""
    for r in rows[1:]:
        if not r:
            continue
        label = r[0]
        badge = badge_of(label)
        if badge and label.strip().lower() not in ROLLUP_LABELS:
            yield label, badge, r


def _rollup(rows: list[list[str]], name: str) -> list[str] | None:
    for r in rows[1:]:
        if r and r[0].strip().lower() == name.lower():
            return r
    return None


def parse_report(pages: dict, office_name: str | None = None) -> dict:
    """Parse the report's tables into {bas: {badge: {...}}, office: {...},
    weeks: [...], fail_reasons: [...]}. Missing tables are simply skipped."""
    out: dict = {"bas": {}, "office": {}, "weeks": [], "fail_reasons": []}

    def first_grid(key, i=0):
        g = pages.get(key)
        if isinstance(g, dict) and "grids" in g:
            g = g["grids"]
        if isinstance(g, list) and g and isinstance(g[0], (dict, list)) and not isinstance(g[0], str):
            if isinstance(g[0], dict) and "rows" in g[0]:
                return _text_rows(g[i]) if len(g) > i else None
            return _text_rows(g) if i == 0 else None
        return None

    ov = first_grid("overall")
    if ov:
        hdr = ov[0]
        idx = {key: hdr.index(h) for key, h, _ in OVERALL_COLUMNS if h in hdr}
        kinds = {k: kind for k, _, kind in OVERALL_COLUMNS}

        def metrics(cells):
            return {k: parse_value(cells[i], kinds[k]) if i < len(cells) else None for k, i in idx.items()}

        for label, badge, cells in _ba_rows(ov):
            out["bas"].setdefault(badge, {"label": label, "badge": badge})["metrics"] = metrics(cells)
        roll = (office_name and _rollup(ov, office_name)) or _rollup(ov, "Total")
        if roll:
            out["office"] = metrics(roll)

    wk = first_grid("kpis-over-wes")
    if wk:
        hdr = wk[0]
        weeks = [(i, h) for i, h in enumerate(hdr) if re.match(r"\d{2}/\d{2}/\d{4}$", h)]
        out["weeks"] = [h for _, h in weeks]
        for label, badge, cells in _ba_rows(wk):
            ba = out["bas"].setdefault(badge, {"label": label, "badge": badge})
            ba["weekly_call_rate"] = {h: parse_value(cells[i], "pct") for i, h in weeks if i < len(cells)}

    fr = first_grid("fail-rate")
    if fr:
        hdr = fr[0]
        for label, badge, cells in _ba_rows(fr):
            ba = out["bas"].setdefault(badge, {"label": label, "badge": badge})
            ba["fails"] = {
                "total_sales": parse_value(cells[hdr.index("Total sales")], "int") if "Total sales" in hdr else None,
                "fail_count": parse_value(cells[hdr.index("Fail count")], "int") if "Fail count" in hdr else None,
            }
    reasons = first_grid("fail-rate", 1)
    if reasons:
        out["fail_reasons"] = [{"reason": r[0] or "Not given", "count": parse_value(r[1], "int")}
                               for r in reasons[1:] if len(r) > 1 and r[0].strip().lower() != "total"]

    ns = first_grid("no-show")
    if ns:
        hdr = ns[0]
        for label, badge, cells in _ba_rows(ns):
            ba = out["bas"].setdefault(badge, {"label": label, "badge": badge})
            if "Net Sign Ups" in hdr:
                ba["net_signups"] = parse_value(cells[hdr.index("Net Sign Ups")], "int")
    return out
