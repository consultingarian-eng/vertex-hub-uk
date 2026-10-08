"""Public roster share — a secret link the owner can send to anyone (no login)
that pulls the CURRENT active-rep roster live from OwnerIQ for every office
and cross-checks it against active app accounts.

  GET /public/roster/{token}        → HTML page with a big "Pull" button
  GET /public/roster/{token}/data   → does the live pull, returns JSON

The token is the only gate (same model as the other /public pages): anyone
with the link can pull, nobody can guess it. The feature is OFF until
ROSTER_SHARE_TOKEN is set (use a long random string); unset, both routes 404.

Matching mirrors reconcile(): an OwnerIQ rep is linked to a CG1 user by badge
number first (badge_number_list vs badges / users' badge numbers),
falling back to whitespace-normalised full name. Buckets per office:
  • both       — active on OwnerIQ AND has an active CG1 account
  • oiq_only   — active on OwnerIQ, but no active CG1 account
  • cg1_only   — active CG1 account, but not active on OwnerIQ
"""
import os
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from database import db
from core.brand import APP_NAME
from core.rate_limit import Limiter, client_ip

logger = logging.getLogger(__name__)
router = APIRouter()

MIN_TOKEN_LENGTH = 32
# Wrong tokens per caller IP: 10 per 15 minutes, then 429.
_TOKEN_FAILURES = Limiter(10, 15 * 60)


def _share_token() -> str:
    """ROSTER_SHARE_TOKEN, or "" (feature off) when unset or shorter than
    MIN_TOKEN_LENGTH: the link is the only gate, so it must be unguessable."""
    token = (os.getenv("ROSTER_SHARE_TOKEN") or "").strip()
    if token and len(token) < MIN_TOKEN_LENGTH:
        logger.warning("ROSTER_SHARE_TOKEN is shorter than %d characters; the roster share page stays off",
                       MIN_TOKEN_LENGTH)
        return ""
    return token


def _check_token(token: str, request: Optional[Request] = None) -> None:
    import secrets
    expected = _share_token()
    if not expected:
        raise HTTPException(status_code=404, detail="Not found")
    key = client_ip(request) if request is not None else "unknown"
    _TOKEN_FAILURES.check(key)
    if not token or not secrets.compare_digest(token.encode(), expected.encode()):
        _TOKEN_FAILURES.hit(key)
        raise HTTPException(status_code=404, detail="Not found")


def _norm_name(s) -> str:
    return " ".join((s or "").split()).lower()


async def _office_id_by_pin() -> dict:
    """App office id → OwnerIQ pin, via the same mapping reconcile uses."""
    from owneriq_config import office_pin_map
    return await office_pin_map()


async def _pull_comparison() -> dict:
    from owneriq_sync import _login, _select_company, _build_rep_resolvers, company_pins, OWNERIQ_API_BASE, _UA
    from owneriq_config import known_companies, root_user_ids

    by_badge, by_name = await _build_rep_resolvers()

    # Active CG1 users, grouped by office pin
    office_to_pin = await _office_id_by_pin()
    cg1_active: dict[str, dict] = {}  # cg1 uid → {name, role, pin}
    async for u in db.users.find(
        {"deleted": {"$ne": True}, "is_active": {"$ne": False}, "is_demo": {"$ne": True}},
        {"_id": 1, "name": 1, "role": 1, "office_id": 1},
    ):
        cg1_active[str(u["_id"])] = {
            "name": u.get("name") or "",
            "role": u.get("role") or "",
            "pin": office_to_pin.get(u.get("office_id")),
        }

    offices = []
    hdrs_extra = {"accept": "application/vnd.api+json", "x-requested-with": "XMLHttpRequest",
                  "origin": "https://owner-iq.ai", "user-agent": _UA}
    async with httpx.AsyncClient(timeout=60.0) as client:
        tok = await _login(client)
        H = {**hdrs_extra, "authorization": f"Bearer {tok}"}
        pins = await company_pins(client, tok)
        pin_names = {c["pin"]: c.get("name") for c in await known_companies()}
        global_roots = root_user_ids()
        for pin in pins:
            office_name = pin_names.get(pin) or f"Office {pin}"
            try:
                # This GET is also the session's company selector (side-effect,
                # same as _select_company). It returns ALL companies — pick ours
                # by the pin attribute.
                r = await client.get(f"{OWNERIQ_API_BASE}/v2/marketing_companies",
                                     params={"mc_pin": pin}, headers=H)
                data = (r.json().get("data") or []) if r.status_code == 200 else []
                mine = next((c for c in data if (c.get("attributes", {}) or {}).get("pin") == pin), None)
                if mine:
                    office_name = (mine.get("attributes", {}) or {}).get("name") or office_name
            except Exception:
                await _select_company(client, tok, pin)

            r = await client.get(
                f"{OWNERIQ_API_BASE}/v2/users?limit=2000&sortColumn=name&sortDirection=asc",
                headers=H,
            )
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail=f"OwnerIQ roster for {office_name}: HTTP {r.status_code}")

            both, oiq_only = [], []
            claimed_cg1: set[str] = set()
            for u in r.json().get("data", []):
                at = u.get("attributes", {}) or {}
                oid = str(u["id"])
                if oid in global_roots or not at.get("active"):
                    continue  # platform-wide root node / inactive
                full_name = at.get("full_name") or ""
                stage = str(at.get("stage") or "").replace("stage_", "")
                badges = {b.strip().upper() for b in str(at.get("badge_number_list") or "").replace(",", " ").split() if b.strip()}
                # badge link first, then normalised name
                cg1_uid = next((by_badge[b] for b in badges if b in by_badge), None) \
                    or by_name.get(_norm_name(full_name))
                entry = {"name": full_name, "stage": stage}
                if cg1_uid and cg1_uid in cg1_active:
                    claimed_cg1.add(cg1_uid)
                    cg1n = cg1_active[cg1_uid]["name"]
                    if _norm_name(cg1n) != _norm_name(full_name):
                        entry["cg1_name"] = cg1n
                    both.append(entry)
                else:
                    entry["reason"] = f"{APP_NAME} account deactivated/deleted" if cg1_uid else f"no {APP_NAME} account found"
                    oiq_only.append(entry)

            cg1_only = sorted(
                ({"name": v["name"], "role": v["role"]}
                 for uid, v in cg1_active.items() if v["pin"] == pin and uid not in claimed_cg1),
                key=lambda x: x["name"].lower(),
            )
            offices.append({
                "pin": pin, "office": office_name,
                "both": both, "oiq_only": oiq_only, "cg1_only": cg1_only,
                "counts": {"owneriq_active": len(both) + len(oiq_only),
                           "both": len(both), "oiq_only": len(oiq_only), "cg1_only": len(cg1_only)},
            })

    return {"pulled_at": datetime.now(timezone.utc).isoformat(), "offices": offices}


@router.get("/public/roster/{token}/data")
async def roster_data(token: str, request: Request):
    _check_token(token, request)
    if not os.getenv("OWNERIQ_EMAIL") or not os.getenv("OWNERIQ_PASSWORD"):
        return JSONResponse(status_code=503, content={"detail": "OwnerIQ credentials are not configured on the server"})
    try:
        return await _pull_comparison()
    except HTTPException:
        raise
    except Exception:
        logger.exception("roster share pull failed")
        return JSONResponse(status_code=502, content={"detail": "Pull failed. The server log has the details."})


@router.get("/public/roster/{token}", response_class=HTMLResponse)
async def roster_page(token: str, request: Request):
    _check_token(token, request)
    # token is server-validated above; the page calls its own /data sibling
    return HTMLResponse(_PAGE)


PAGE_HTML = """<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Active BAs — OwnerIQ × __APP__</title>
<style>
  :root { --bg:#0b211c; --card:#102d25; --line:#244c3b; --txt:#f0f4e9; --mut:#b9c9b8;
          --green:#b7df58; --amber:#f5b942; --blue:#8fd3e8; --red:#f39a8f; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--txt); font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:20px 14px 60px; }
  .wrap { max-width:760px; margin:0 auto; }
  h1 { font-size:20px; margin-bottom:2px; }
  .sub { color:var(--mut); font-size:13px; margin-bottom:18px; }
  .pull { display:flex; gap:10px; align-items:center; margin-bottom:20px; flex-wrap:wrap; }
  button { font:inherit; border:0; border-radius:10px; cursor:pointer; font-weight:700; }
  #pullBtn { background:var(--green); color:#102d25; padding:12px 22px; font-size:16px; }
  #pullBtn:disabled { opacity:.5; cursor:wait; }
  #csvBtn { background:var(--card); color:var(--blue); border:1px solid var(--line); padding:11px 16px; display:none; }
  #stamp { color:var(--mut); font-size:12px; }
  #err { color:var(--red); font-size:13px; margin-bottom:14px; display:none; }
  .office { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:18px; }
  .office h2 { font-size:17px; margin-bottom:2px; }
  .counts { color:var(--mut); font-size:12px; margin-bottom:12px; }
  .sec { margin-top:12px; }
  .sec h3 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; margin-bottom:6px; }
  .sec.both h3 { color:var(--green); } .sec.oiq h3 { color:var(--amber); } .sec.cg1 h3 { color:var(--blue); }
  ul { list-style:none; }
  li { padding:7px 10px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:10px; }
  li:last-child { border-bottom:0; }
  li .meta { color:var(--mut); font-size:12px; white-space:nowrap; }
  .none { color:var(--mut); font-style:italic; font-size:13px; padding:4px 10px; }
  .spinner { display:none; width:18px; height:18px; border:3px solid var(--line); border-top-color:var(--green); border-radius:50%; animation:sp 1s linear infinite; }
  @keyframes sp { to { transform:rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <h1>Active BAs — OwnerIQ × __APP__</h1>
  <div class="sub">Live pull of everyone currently active on OwnerIQ for every office, matched against active __APP__ accounts.</div>
  <div class="pull">
    <button id="pullBtn">Pull current roster</button>
    <div class="spinner" id="spin"></div>
    <button id="csvBtn">Download CSV</button>
    <span id="stamp"></span>
  </div>
  <div id="err"></div>
  <div id="out"></div>
</div>
<script>
let last = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// Stored role values read as the self-employed titles (leader = Coach, trainee = BA).
const ROLE_WORD = { leader: 'Coach', trainee: 'BA', admin: 'Admin' };
const roleWord = (r) => ROLE_WORD[r] || r || '';

function section(cls, title, rows, meta) {
  let lis = rows.length
    ? rows.map(r => `<li><span>${esc(r.name)}${r.cg1_name ? ` <span class="meta">(__APP__: ${esc(r.cg1_name)})</span>` : ''}</span><span class="meta">${esc(meta(r))}</span></li>`).join('')
    : '<div class="none">Nobody in this bucket</div>';
  return `<div class="sec ${cls}"><h3>${title} (${rows.length})</h3><ul>${lis}</ul></div>`;
}

function render(data) {
  $('out').innerHTML = data.offices.map(o => `
    <div class="office">
      <h2>${esc(o.office)}</h2>
      <div class="counts">${o.counts.owneriq_active} active on OwnerIQ &middot; ${o.counts.both} on both &middot; ${o.counts.oiq_only} OwnerIQ only &middot; ${o.counts.cg1_only} __APP__ only</div>
      ${section('both', 'Active on both', o.both, r => r.stage ? 'Stage ' + r.stage : '')}
      ${section('oiq', 'OwnerIQ only (no active __APP__ account)', o.oiq_only, r => r.reason || '')}
      ${section('cg1', '__APP__ only (not active on OwnerIQ)', o.cg1_only, r => roleWord(r.role))}
    </div>`).join('');
  $('stamp').textContent = 'Pulled ' + new Date(data.pulled_at).toLocaleString('en-GB');
  $('csvBtn').style.display = 'inline-block';
}

$('pullBtn').onclick = async () => {
  $('err').style.display = 'none';
  $('pullBtn').disabled = true; $('spin').style.display = 'block';
  try {
    const r = await fetch(location.pathname.replace(/\\/$/, '') + '/data');
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || ('HTTP ' + r.status));
    last = data; render(data);
  } catch (e) {
    $('err').textContent = 'Pull failed: ' + e.message;
    $('err').style.display = 'block';
  }
  $('pullBtn').disabled = false; $('spin').style.display = 'none';
};

$('csvBtn').onclick = () => {
  if (!last) return;
  const rows = [['Office','Name','Status','Detail']];
  for (const o of last.offices) {
    o.both.forEach(r => rows.push([o.office, r.name, 'Active on both', r.stage ? 'Stage ' + r.stage : '']));
    o.oiq_only.forEach(r => rows.push([o.office, r.name, 'OwnerIQ only', r.reason || '']));
    o.cg1_only.forEach(r => rows.push([o.office, r.name, '__APP__ only', roleWord(r.role)]));
  }
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
  a.download = 'active-bas-owneriq-__SLUG__.csv';
  a.click();
};
</script>
</body>
</html>"""


def _slug(name: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-") or "app"


# APP_NAME is escaped for HTML and JS-string use; the page is otherwise static.
_PAGE = (PAGE_HTML
         .replace("__APP__", APP_NAME.replace("&", "&amp;").replace("<", "&lt;").replace("'", "&#39;"))
         .replace("__SLUG__", _slug(APP_NAME)))
