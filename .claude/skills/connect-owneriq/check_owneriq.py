#!/usr/bin/env python3
"""Read-only OwnerIQ connection check (standard library only).

What it does, in order:
  1. Logs in to OwnerIQ with your owner login, exactly as the app does
     (POST /v3/owner/sessions).
  2. Lists the marketing companies that login can see
     (GET /v2/marketing_companies and GET /v3/owner/marketing_companies/light_index).
  3. Prints each company's id, pin and name, plus ready-to-paste values for
     OWNERIQ_MC_PINS and OWNERIQ_OFFICE_PINS.
  4. Only with --roots: for each company, lists the active people at the top
     of your OwnerIQ tree (no parent) and how many people report to each, so
     you can tell your own owner account apart from accounts that belong in
     OWNERIQ_ROOT_USER_IDS. To read a company's people OwnerIQ needs this
     script's own session switched to that company; that changes nothing in
     your OwnerIQ data.

It never creates, edits or deletes anything in OwnerIQ, never touches your
database, and never prints your password or the session token.

Where the login comes from:
  OWNERIQ_EMAIL / OWNERIQ_PASSWORD / OWNERIQ_API_BASE from the environment if
  set, otherwise you are asked (the password is typed hidden).

Usage (from the repo root):
  python3 .claude/skills/connect-owneriq/check_owneriq.py
  python3 .claude/skills/connect-owneriq/check_owneriq.py --roots
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_API_BASE = "https://us.owner-iq.ai"
# The same browser-like headers the app sends (backend/owneriq_sync.py).
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36"
BASE_HEADERS = {
    "origin": "https://owner-iq.ai",
    "referer": "https://owner-iq.ai/",
    "user-agent": UA,
}


def mask(value: str, keep: int = 4) -> str:
    value = value or ""
    return value[:keep] + "…" if len(value) > keep else "…"


def request(method: str, url: str, headers: dict, body: dict | None = None, timeout: float = 45.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, None
    except urllib.error.URLError as e:
        raise SystemExit(
            f"Could not reach {url.split('/v')[0]} ({e.reason}).\n"
            "Check your internet connection and OWNERIQ_API_BASE (default "
            f"{DEFAULT_API_BASE}); OwnerIQ support can confirm your host."
        )


def login(api: str, email: str, password: str) -> str:
    status, body = request(
        "POST", f"{api}/v3/owner/sessions",
        {**BASE_HEADERS, "accept": "*/*", "content-type": "application/json"},
        {"session": {"email": email, "password": password}},
    )
    if status != 200:
        raise SystemExit(
            f"Login failed (HTTP {status}).\n"
            "- Check the email and password work at owner-iq.ai (an OWNER login).\n"
            "- If they do, your account may be on another API host: ask OwnerIQ\n"
            "  support and set OWNERIQ_API_BASE."
        )
    try:
        token = body["data"]["attributes"]["auth_token"]
    except Exception:
        token = ""
    if not token:
        raise SystemExit("Login answered 200 but returned no session token. Ask OwnerIQ support.")
    return token


def api_headers(token: str, jsonapi: bool = True) -> dict:
    return {
        **BASE_HEADERS,
        "accept": "application/vnd.api+json" if jsonapi else "application/json",
        "x-requested-with": "XMLHttpRequest",
        "authorization": f"Bearer {token}",
    }


def companies(api: str, token: str) -> list[dict]:
    status, body = request("GET", f"{api}/v2/marketing_companies", api_headers(token))
    if status != 200:
        print(f"! Listing companies failed (HTTP {status}).")
        return []
    out = []
    for c in (body or {}).get("data") or []:
        at = c.get("attributes") or {}
        pin = str(at.get("pin") or "").strip()
        if pin:
            out.append({"id": str(c.get("id") or ""), "pin": pin, "name": str(at.get("name") or "").strip()})
    return out


def live_company_ids(api: str, token: str) -> list[str]:
    status, body = request("GET", f"{api}/v3/owner/marketing_companies/light_index",
                           api_headers(token, jsonapi=False))
    if status != 200:
        print(f"! light_index failed (HTTP {status}); Live Operations and the Performance Hub use it.")
        return []
    return [str(c["id"]) for c in (body or {}).get("data") or [] if c.get("id") is not None]


def roots(api: str, token: str, pin: str) -> list[dict]:
    status, _ = request("GET", f"{api}/v2/marketing_companies?{urllib.parse.urlencode({'mc_pin': pin})}",
                        api_headers(token))
    if status != 200:
        print(f"  ! could not switch this session to company {pin} (HTTP {status})")
        return []
    status, body = request("GET", f"{api}/v2/users?limit=2000&active=true&sortColumn=name&sortDirection=asc",
                           api_headers(token), timeout=150.0)
    if status != 200:
        print(f"  ! could not read the people list (HTTP {status})")
        return []
    users = (body or {}).get("data") or []
    children: dict[str, int] = {}
    for u in users:
        p = (u.get("attributes") or {}).get("parent_id")
        if p not in (None, 0, "0", ""):
            children[str(p)] = children.get(str(p), 0) + 1
    out = []
    for u in users:
        at = u.get("attributes") or {}
        if at.get("parent_id") in (None, 0) and at.get("active"):
            out.append({"id": str(u.get("id")), "name": at.get("full_name") or "",
                        "reports": children.get(str(u.get("id")), 0)})
    return sorted(out, key=lambda r: -r["reports"])


def main() -> None:
    ap = argparse.ArgumentParser(description="Read-only OwnerIQ connection check.")
    ap.add_argument("--roots", action="store_true",
                    help="also list the top-of-tree accounts per company (for OWNERIQ_ROOT_USER_IDS)")
    args = ap.parse_args()

    api = (os.getenv("OWNERIQ_API_BASE") or DEFAULT_API_BASE).strip().rstrip("/")
    email = (os.getenv("OWNERIQ_EMAIL") or "").strip() or input("OwnerIQ owner email: ").strip()
    password = os.getenv("OWNERIQ_PASSWORD") or getpass.getpass("OwnerIQ password (hidden): ")
    if not email or not password:
        raise SystemExit("An email and a password are both needed.")

    print(f"API host: {api}")
    print(f"Login:    {mask(email)} (password not shown)")
    token = login(api, email, password)
    print("OK  logged in")

    comps = companies(api, token)
    live_ids = set(live_company_ids(api, token))
    if not comps:
        print("\nNo marketing companies listed for this login. The app would then read only the")
        print("login's default company. Check you used an OWNER login, or ask OwnerIQ support.")
        return

    print(f"\nOK  {len(comps)} marketing compan{'y' if len(comps) == 1 else 'ies'} visible:\n")
    print(f"  {'id':<10} {'pin':<12} {'live ops':<9} name")
    for c in comps:
        print(f"  {c['id']:<10} {c['pin']:<12} {'yes' if c['id'] in live_ids else '-':<9} {c['name']}")

    pins = ",".join(c["pin"] for c in comps)
    print("\nSuggested values (edit the office names to match your offices in the app):")
    print(f"  OWNERIQ_MC_PINS={pins}")
    if len(comps) == 1:
        print("  OWNERIQ_OFFICE_PINS   not needed: with one company every office maps to it")
    else:
        print("  OWNERIQ_OFFICE_PINS=" + ",".join(f"{c['name'] or 'Office'}={c['pin']}" for c in comps))
    print("  Note: the Performance Hub screen shows the first company in the 'live ops' list.")

    if args.roots:
        print("\nTop-of-tree accounts (active, no parent), most direct reports first.")
        print("The app treats the one with the most reports as the office owner. Any OTHER")
        print("account here that is not an office owner can go in OWNERIQ_ROOT_USER_IDS.")
        for c in comps:
            print(f"\n  Company {c['pin']} {c['name']}:")
            rows = roots(api, token, c["pin"])
            if not rows:
                print("    (none found)")
            for r in rows:
                print(f"    id {r['id']:<10} reports {r['reports']:<5} {r['name']}")

    print("\nDone. Nothing was changed in OwnerIQ.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
