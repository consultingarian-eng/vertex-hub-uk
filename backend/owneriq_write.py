"""OwnerIQ writes — CG1 → OwnerIQ rep lifecycle (promote / demote / deactivate).

Automates the owner actions otherwise done by hand in the OwnerIQ UI:
  • promote     → POST /v3/owner/users/{id}/advance    {"data":{"attributes":{"effective_at": <iso>}}}
  • demote      → POST /v3/owner/users/{id}/downgrade   (same body)
  • deactivate  → PATCH /v3/owner/users/{id}            {"data":{"attributes":{"active": false}}}
  • reactivate  → PATCH /v3/owner/users/{id}            {"data":{"attributes":{"active": true}}}
Auth = the same Bearer auth_token as the read sync. The user id is GLOBAL (not
office-scoped), so no marketing-company switch is needed.

Stage key (CG1 business meaning; OwnerIQ stores stage_1..stage_N):
  1 trainee · 2 assessed trainee · 3 leader · 4+ leader-with-leaders.

Safety: every call resolves the OwnerIQ user from an UNAMBIGUOUS badge/link
(never a name guess), supports dry_run, and logs to owneriq_write_log.
"""
import os
import logging
from datetime import datetime, timezone

import httpx

from database import db
from owneriq_sync import _login, OWNERIQ_API_BASE as B, _UA, OwnerIQError, ID_LINKED, is_oid

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


_WRITES_OFF = "OwnerIQ writes are off. Set OWNERIQ_WRITES_ENABLED=true to allow them (dry runs always work)."


def clean_oid(value) -> str | None:
    """An OwnerIQ id as digits, or None. Ids go into request paths, so anything
    else (slashes, dots, query strings) is refused rather than escaped."""
    s = str(value if value is not None else "").strip()
    return s if is_oid(s) else None


def _hdrs(tok: str) -> dict:
    return {
        "accept": "*/*",
        "content-type": "application/json",
        "origin": "https://owner-iq.ai",
        "user-agent": _UA,
        "authorization": f"Bearer {tok}",
    }


def _stage_num(stage: str | None) -> float | None:
    """OwnerIQ stage string → comparable number. Handles the '_plus' tiers, e.g.
    stage_3 → 3, stage_3_plus → 3.5 (a leader-with-a-leader, ABOVE stage 3), so
    reconcile's 'at least stage 3' floor never downgrades a 3+ leader."""
    if not stage:
        return None
    import re
    s = str(stage).lower().replace("stage_", "").strip()
    plus = 0.5 if s.endswith("_plus") else 0.0
    m = re.match(r"(\d+)", s)
    return (int(m.group(1)) + plus) if m else None


async def resolve_owneriq_user_id(cg1_user_id: str, client: httpx.AsyncClient, tok: str) -> str | None:
    """CG1 user id → OwnerIQ user id, via our existing badge link.

    Primary: the linked owneriq_kpis rows already carry owneriq_user_id.
    Fallback: match the rep's CG1 badge codes against the OwnerIQ roster's
    badge_number_list."""
    row = await db.owneriq_kpis.find_one(
        {"cg1_user_id": cg1_user_id, "owneriq_user_id": {"$ne": None}, **ID_LINKED},
        sort=[("date", -1)],
    )
    if row and row.get("owneriq_user_id"):
        return str(row["owneriq_user_id"])

    # Fallback: the rep's badge codes (same 3 sources the linker uses).
    from owneriq_sync import _build_rep_resolvers
    by_badge, _ = await _build_rep_resolvers()
    my_badges = {bn for bn, uid in by_badge.items() if uid == cg1_user_id}
    if not my_badges:
        return None
    from owneriq_sync import _select_company, company_pins
    for pin in await company_pins(client, tok):
        await _select_company(client, tok, pin)
        r = await client.get(
            f"{B}/v2/users?limit=2000&sortColumn=name&sortDirection=asc",
            headers={**_hdrs(tok), "accept": "application/vnd.api+json", "x-requested-with": "XMLHttpRequest"},
        )
        if r.status_code != 200:
            continue
        for u in r.json().get("data", []):
            bl = (u.get("attributes", {}) or {}).get("badge_number_list") or ""
            have = {b.strip().upper() for b in str(bl).replace(",", " ").split() if b.strip()}
            if my_badges & have:
                return str(u["id"])
    return None


async def _get_user(client: httpx.AsyncClient, tok: str, oid: str) -> dict:
    r = await client.get(
        f"{B}/v3/owner/users/{oid}",
        headers={**_hdrs(tok), "accept": "application/vnd.api+json", "x-requested-with": "XMLHttpRequest"},
    )
    if r.status_code != 200:
        raise OwnerIQError(f"read user {oid} failed: HTTP {r.status_code} {r.text[:150]}")
    return (r.json().get("data", {}) or {}).get("attributes", {}) or {}


async def _advance(client, tok, oid):
    return await client.post(f"{B}/v3/owner/users/{oid}/advance",
                             json={"data": {"attributes": {"effective_at": _now_iso()}}}, headers=_hdrs(tok))


async def _downgrade(client, tok, oid):
    return await client.post(f"{B}/v3/owner/users/{oid}/downgrade",
                             json={"data": {"attributes": {"effective_at": _now_iso()}}}, headers=_hdrs(tok))


async def _set_active(client, tok, oid, active: bool):
    return await client.patch(f"{B}/v3/owner/users/{oid}",
                              json={"data": {"attributes": {"active": active}}}, headers=_hdrs(tok))


async def perform(cg1_user_id: str | None, action: str, target_stage: int | None = None,
                  dry_run: bool = False, actor: str | None = None,
                  owneriq_user_id: str | None = None) -> dict:
    """Run a rep-lifecycle action against OwnerIQ.

    action ∈ {promote, demote, set_stage, deactivate, reactivate}.
    Pass cg1_user_id (resolved via badge link) OR an explicit owneriq_user_id
    (e.g. to test against a test profile). For set_stage, target_stage
    is the desired stage number.
    """
    if not dry_run and not writes_enabled():
        # Every write path checks the switch itself, not only its callers.
        return {"ok": False, "error": _WRITES_OFF}
    if owneriq_user_id is not None and not clean_oid(owneriq_user_id):
        return {"ok": False, "error": "owneriq_user_id must be a numeric OwnerIQ id."}
    async with httpx.AsyncClient(timeout=45.0) as client:
        tok = await _login(client)
        oid = clean_oid(owneriq_user_id) or (await resolve_owneriq_user_id(cg1_user_id, client, tok) if cg1_user_id else None)
        oid = clean_oid(oid)
        if not oid:
            return {"ok": False, "error": "Could not resolve this BA in OwnerIQ (no linked badge match)."}

        before = await _get_user(client, tok, oid)
        cur_stage = _stage_num(before.get("stage"))
        cur_active = bool(before.get("active"))
        plan: list[str] = []

        if action in ("deactivate", "reactivate"):
            want = action == "reactivate"
            if cur_active == want:
                plan = [f"already active={want}"]
            else:
                plan = [f"PATCH active={want}"]
        elif action in ("promote", "demote", "set_stage"):
            if cur_stage is None:
                return {"ok": False, "error": "OwnerIQ has no stage for this BA."}
            if action == "promote":
                plan = ["advance 1 stage"]
            elif action == "demote":
                plan = ["downgrade 1 stage"] if cur_stage > 1 else ["already at stage 1"]
            else:  # set_stage — a floor; only advances, never downgrades
                target = max(int(target_stage), 1)
                plan = [f"advance to stage {target}"] if cur_stage < target else ["already at/above target"]
        else:
            return {"ok": False, "error": f"Unknown action '{action}'."}

        result = {"ok": True, "owneriq_user_id": oid, "name": before.get("full_name"),
                  "before": {"stage": before.get("stage"), "active": cur_active},
                  "plan": plan, "dry_run": dry_run}

        if dry_run:
            return result

        # Execute.
        try:
            if action in ("deactivate", "reactivate"):
                want = action == "reactivate"
                if cur_active != want:
                    r = await _set_active(client, tok, oid, want)
                    if r.status_code not in (200, 204):
                        raise OwnerIQError(f"PATCH failed: HTTP {r.status_code} {r.text[:150]}")
            elif action == "promote":
                r = await _advance(client, tok, oid)
                if r.status_code != 200:
                    raise OwnerIQError(f"advance failed: HTTP {r.status_code} {r.text[:150]}")
            elif action == "demote":
                if (cur_stage or 1) > 1:
                    r = await _downgrade(client, tok, oid)
                    if r.status_code != 200:
                        raise OwnerIQError(f"downgrade failed: HTTP {r.status_code} {r.text[:150]}")
            else:  # set_stage — advance-only floor; never downgrades a higher tier
                target = max(int(target_stage), 1)
                guard = 0
                while (cur_stage or 0) < target and guard < 8:
                    r = await _advance(client, tok, oid)
                    if r.status_code != 200:
                        raise OwnerIQError(f"advance failed: HTTP {r.status_code} {r.text[:150]}")
                    new_stage = _stage_num((r.json().get("data", {}) or {}).get("attributes", {}).get("stage"))
                    if new_stage is None or new_stage <= (cur_stage or 0):
                        break
                    cur_stage = new_stage
                    guard += 1
        except Exception as ex:
            result.update({"ok": False, "error": str(ex)})

        after = await _get_user(client, tok, oid)
        result["after"] = {"stage": after.get("stage"), "active": bool(after.get("active"))}

    await db.owneriq_write_log.insert_one({
        "at": _now_iso(), "actor": actor, "cg1_user_id": cg1_user_id,
        "owneriq_user_id": oid, "action": action, "target_stage": target_stage,
        "result": {k: result.get(k) for k in ("ok", "before", "after", "plan", "error")},
    })
    return result


async def _reparent(client, tok, oid, parent_oid):
    return await client.patch(f"{B}/v3/owner/users/{oid}",
                              json={"data": {"attributes": {"parent_id": int(parent_oid)}}}, headers=_hdrs(tok))


async def reparent(cg1_user_id: str, leader_cg1_user_id: str, dry_run: bool = False,
                   actor: str | None = None) -> dict:
    """Move a rep under a leader in the OwnerIQ family tree (sets parent_id)."""
    if not dry_run and not writes_enabled():
        return {"ok": False, "error": _WRITES_OFF}
    async with httpx.AsyncClient(timeout=45.0) as client:
        tok = await _login(client)
        oid = clean_oid(await resolve_owneriq_user_id(cg1_user_id, client, tok))
        poid = clean_oid(await resolve_owneriq_user_id(leader_cg1_user_id, client, tok))
        if not oid:
            return {"ok": False, "error": "BA not resolvable in OwnerIQ."}
        if not poid:
            return {"ok": False, "error": "New coach not resolvable in OwnerIQ."}
        if str(poid) == str(oid):
            return {"ok": True, "skipped": "cannot place a BA under themselves"}
        before = await _get_user(client, tok, oid)
        result = {"ok": True, "owneriq_user_id": oid, "parent_owneriq_id": poid,
                  "name": before.get("full_name"), "before_parent": before.get("parent_id"),
                  "dry_run": dry_run}
        if not dry_run:
            r = await _reparent(client, tok, oid, poid)
            if r.status_code not in (200, 204):
                result.update({"ok": False, "error": f"PATCH parent_id failed: HTTP {r.status_code} {r.text[:150]}"})
            else:
                after = await _get_user(client, tok, oid)
                result["after_parent"] = after.get("parent_id")
    await db.owneriq_write_log.insert_one({
        "at": _now_iso(), "actor": actor, "cg1_user_id": cg1_user_id,
        "owneriq_user_id": oid, "action": "reparent", "leader_cg1_user_id": leader_cg1_user_id,
        "result": {k: result.get(k) for k in ("ok", "before_parent", "after_parent", "error")},
    })
    return result


async def _office_pin_for_user(office_id: str | None) -> str | None:
    from owneriq_config import office_pin
    return await office_pin(office_id)


def pick_owner_node(roots: list[str], parent_ids: list, global_roots: set) -> str | None:
    """The office's owner node: of the active roots (minus OWNERIQ_ROOT_USER_IDS),
    the one with the most direct reports. A roster's roots also hold MC admins,
    bookkeepers, agency staff and fresh applicants (all childless), so "first
    root by name" can pick an admin and reparent the real owner under them."""
    children: dict[str, int] = {}
    for p in parent_ids:
        if p not in (None, 0, "0", ""):
            children[str(p)] = children.get(str(p), 0) + 1
    pool = [x for x in roots if x not in global_roots] or list(roots)
    if not pool:
        return None
    return max(pool, key=lambda oid: children.get(str(oid), 0))  # ties → roster order


async def reconcile(dry_run: bool = True, actor: str | None = None) -> dict:
    """Idempotently align OwnerIQ to CG1 for every badge-linked rep — the
    backfill for reps assigned/promoted in CG1 *before* they existed on OwnerIQ
    (event hooks can't fire for someone not yet on OwnerIQ). Aligns:
      • parent_id  → their CG1 leader (reports_to), else the office owner node
      • active     → CG1 not-deleted/active
      • stage ≥ 3  → CG1 leaders/admins
    dry_run=True is READ-ONLY (returns the planned diff). Real writes still need
    OWNERIQ_WRITES_ENABLED."""
    from owneriq_sync import _select_company, _build_rep_resolvers, company_pins
    from owneriq_config import root_user_ids
    async with httpx.AsyncClient(timeout=60.0) as client:
        tok = await _login(client)
        H = {"accept": "application/vnd.api+json", "x-requested-with": "XMLHttpRequest",
             "origin": "https://owner-iq.ai", "user-agent": _UA, "authorization": f"Bearer {tok}"}

        # 1) OwnerIQ roster per office → current parent/stage/active/badges.
        roster: dict[str, dict] = {}
        owner_by_pin: dict[str, str] = {}
        global_roots = root_user_ids()
        partial = False
        for pin in await company_pins(client, tok):
            await _select_company(client, tok, pin)
            # The full roster (every leaver too) can time out on OwnerIQ's side;
            # then read just the active reps and infer leavers below.
            try:
                r = await client.get(f"{B}/v2/users?limit=2000&sortColumn=name&sortDirection=asc", headers=H, timeout=150.0)
                if r.status_code in (502, 503, 504):
                    raise httpx.ReadTimeout("roster gateway timeout")
            except httpx.TimeoutException:
                partial = True
                r = await client.get(f"{B}/v2/users?limit=2000&active=true&sortColumn=name&sortDirection=asc", headers=H, timeout=150.0)
            roots = []
            for u in r.json().get("data", []):
                at = u.get("attributes", {}) or {}
                oid = str(u["id"])
                badges = {b.strip().upper() for b in str(at.get("badge_number_list") or "").replace(",", " ").split() if b.strip()}
                roster[oid] = {"parent_id": at.get("parent_id"), "stage": _stage_num(at.get("stage")),
                               "active": bool(at.get("active")), "badges": badges, "pin": pin,
                               "name": at.get("full_name")}
                if at.get("parent_id") in (None, 0) and at.get("active"):
                    roots.append(oid)
            owner_by_pin[pin] = pick_owner_node(
                roots, [info["parent_id"] for oid, info in roster.items() if info["pin"] == pin], global_roots)

        if partial:
            # Active-only roster: someone who was active last run and is missing
            # now has been deactivated in OwnerIQ.
            async for st in db.owneriq_link_state.find({"active": True}):
                if st["_id"] not in roster:
                    roster[st["_id"]] = {"parent_id": st.get("parent_id"), "stage": st.get("stage"),
                                         "active": False, "badges": set(), "pin": None, "name": None}

        badge_to_oid: dict[str, str] = {}
        for oid, info in roster.items():
            for b in info["badges"]:
                badge_to_oid.setdefault(b, oid)

        # 2) App user → OwnerIQ id: the stored link (users.owneriq_user_id, set
        #    by the Performance Hub sync from roster email/badge) first, then badges.
        by_badge, _ = await _build_rep_resolvers()
        cg1_badges: dict[str, set] = {}
        for b, uid in by_badge.items():
            cg1_badges.setdefault(uid, set()).add(b)
        stored = {str(u["_id"]): str(u["owneriq_user_id"]) async for u in db.users.find(
            {"owneriq_user_id": {"$ne": None}}, {"owneriq_user_id": 1})}

        def cg1_to_oid(cg1_uid: str) -> str | None:
            if cg1_uid in stored:
                return stored[cg1_uid]
            for b in cg1_badges.get(cg1_uid, ()):
                if b in badge_to_oid:
                    return badge_to_oid[b]
            return None

        # 3) Every linked app user, deduped by OwnerIQ id, preferring the ACTIVE
        #    record — a rep who was binned then re-added (returned) has an old
        #    deleted record + a new active one sharing the same link.
        by_oid: dict[str, dict] = {}
        async for u in db.users.find({}, {"_id": 1, "role": 1, "reports_to": 1, "deleted": 1, "is_active": 1,
                                          "office_id": 1, "name": 1, "new_hire_id": 1}):
            oid = cg1_to_oid(str(u["_id"]))
            if not oid or oid not in roster:
                continue
            u["_cg1_uid"] = str(u["_id"])
            active = not (u.get("deleted") or u.get("is_active") is False)
            ex = by_oid.get(oid)
            if ex is None or (active and (ex.get("deleted") or ex.get("is_active") is False)):
                by_oid[oid] = u
        owner_oids = {v for v in owner_by_pin.values() if v}
        two_way = not dry_run and writes_enabled()

        # 4) Change-based two-way sync. owneriq_link_state remembers, per linked
        #    rep, how BOTH sides looked after the last run (OwnerIQ: active,
        #    parent, stage; app: active, coach, role). Only CHANGES move:
        #      - changed in OwnerIQ, not in the app  -> copied into the app (pull)
        #      - changed in the app                  -> sent to OwnerIQ (push)
        #    A difference that already existed before the sync started (first
        #    run, or both sides edited) changes nothing and is listed under
        #    `mismatches` for an admin to settle. Staff accounts (admins that
        #    aren't the owner) are never moved or staged.
        seen = {d["_id"]: d async for d in db.owneriq_link_state.find({"_id": {"$in": list(by_oid)}})}

        def app_view(u: dict) -> dict:
            return {"app_active": not (u.get("deleted") or u.get("is_active") is False),
                    "app_coach": u.get("reports_to") or None, "app_role": u.get("role")}

        pulls, actions, mismatches = [], [], []
        for oid, u in by_oid.items():
            if oid in owner_oids:
                continue  # never touch the office owner/root nodes
            cur, prev, now = roster[oid], seen.get(oid), app_view(u)
            staff = u.get("role") == "admin"
            desired_parent = cg1_to_oid(str(now["app_coach"])) if now["app_coach"] else None
            if prev is None:
                differs = bool(cur["active"]) != now["app_active"] or (
                    not staff and desired_parent and str(cur["parent_id"]) != str(desired_parent))
                if differs:
                    mismatches.append({"cg1_user_id": u["_cg1_uid"], "name": u.get("name"), "owneriq_user_id": oid,
                                       "owneriq_active": bool(cur["active"]), "app_active": now["app_active"]})
                continue
            change: dict = {}
            plan: list = []
            # Active / deactivated
            oiq_moved = bool(cur["active"]) != bool(prev.get("active"))
            app_moved = now["app_active"] != prev.get("app_active", now["app_active"])
            if app_moved and bool(cur["active"]) != now["app_active"]:
                plan.append(["set_active", now["app_active"]])
            elif oiq_moved and not app_moved and bool(cur["active"]) != now["app_active"]:
                change["is_active"] = bool(cur["active"])
            # Coach / parent
            if not staff and (now["app_active"] or change.get("is_active")):
                oiq_moved = str(cur["parent_id"] or "") != str(prev.get("parent_id") or "")
                app_moved = (now["app_coach"] or None) != (prev.get("app_coach") or None)
                if app_moved and desired_parent and str(cur["parent_id"]) != str(desired_parent) and str(desired_parent) != oid:
                    plan.append(["reparent", desired_parent])
                elif oiq_moved and not app_moved:
                    parent = by_oid.get(str(cur["parent_id"]))
                    if parent and parent.get("role") in ("leader", "admin") and parent["_cg1_uid"] != u["_cg1_uid"]:
                        change["reports_to"] = parent["_cg1_uid"]
            # Stage 3 line <-> Coach role
            if not staff:
                was, is_ = prev.get("stage") or 0, cur["stage"] or 0
                app_moved = now["app_role"] != prev.get("app_role", now["app_role"])
                if app_moved and now["app_role"] == "leader" and is_ < 3:
                    plan.append(["set_stage", 3])
                elif not app_moved and is_ >= 3 > was and now["app_role"] == "trainee":
                    change["role"] = "leader"
                elif not app_moved and was >= 3 > is_ and now["app_role"] == "leader":
                    change["role"] = "trainee"
            if change:
                pulls.append({"cg1_user_id": u["_cg1_uid"], "name": u.get("name"), "owneriq_user_id": oid, "change": change})
                if two_way:
                    await db.users.update_one({"_id": u["_id"]}, {"$set": {**change, "owneriq_pulled_at": _now_iso()}})
                    if change.get("role") in ("leader", "trainee"):
                        from routes.admin_routes import close_out_promoted_hire, reopen_demoted_hire
                        if change["role"] == "leader":
                            await close_out_promoted_hire({**u, **change})
                        else:
                            await reopen_demoted_hire({**u, **change})
                u.update(change)
            if plan:
                actions.append({"cg1_user_id": u["_cg1_uid"], "name": u.get("name"), "owneriq_user_id": oid, "plan": plan})

        # 5) Apply pushes (only if not dry_run AND writes enabled), then
        #    remember how both sides look now (the next run's baseline).
        applied = 0
        if two_way:
            for a in actions:
                oid = clean_oid(a["owneriq_user_id"])
                if not oid:
                    a.setdefault("errors", []).append("non-numeric OwnerIQ id skipped")
                    continue
                for kind, val in a["plan"]:
                    try:
                        if kind == "set_active":
                            r = await _set_active(client, tok, oid, val)
                            if r.status_code >= 300:
                                raise OwnerIQError(f"HTTP {r.status_code}")
                            roster[oid]["active"] = val
                        elif kind == "reparent":
                            r = await _reparent(client, tok, oid, val)
                            if r.status_code >= 300:
                                raise OwnerIQError(f"HTTP {r.status_code}")
                            roster[oid]["parent_id"] = val
                        elif kind == "set_stage":
                            cur_s = roster[oid]["stage"] or 1
                            g = 0
                            while cur_s < 3 and g < 6:
                                rr = await _advance(client, tok, oid)
                                cur_s = _stage_num((rr.json().get("data", {}) or {}).get("attributes", {}).get("stage")) or cur_s
                                g += 1
                            roster[oid]["stage"] = cur_s
                        applied += 1
                    except Exception as e:
                        a.setdefault("errors", []).append(f"{kind}: {e}")
            for oid, u in by_oid.items():
                cur = roster[oid]
                await db.owneriq_link_state.update_one({"_id": oid}, {"$set": {
                    "active": bool(cur["active"]), "parent_id": cur["parent_id"], "stage": cur["stage"],
                    **app_view(u), "at": _now_iso()}}, upsert=True)

    if two_way:
        await db.owneriq_write_log.insert_one({
            "at": _now_iso(), "actor": actor, "action": "reconcile",
            "result": {"candidates": len(actions), "applied": applied, "pulled": len(pulls), "mismatches": len(mismatches)},
        })
    return {"ok": True, "dry_run": dry_run, "writes_enabled": writes_enabled(),
            "owner_nodes": owner_by_pin, "candidates": len(actions), "applied": applied,
            "actions": actions[:250], "pulled": pulls[:250], "mismatches": mismatches[:250]}


# ── auto-hooks (fired from CG1 flows) ───────────────────────────────────────
def writes_enabled() -> bool:
    """Master switch — real writes only fire when OWNERIQ_WRITES_ENABLED is set.
    Off by default so promotions/terminations never touch OwnerIQ until you flip
    it on in the host secrets."""
    return (os.getenv("OWNERIQ_WRITES_ENABLED") or "").strip().lower() in ("1", "true", "yes", "on")


async def hook_promotion_to_leader(cg1_user_id: str):
    """CG1 promoted a trainee to leader → set OwnerIQ stage 3 (leader)."""
    if not writes_enabled():
        return
    try:
        res = await perform(cg1_user_id, "set_stage", target_stage=3, dry_run=False, actor="auto:promotion")
        logger.info("OwnerIQ auto-promote %s -> %s", cg1_user_id, res.get("after") or res.get("error"))
    except Exception as e:
        logger.error("OwnerIQ auto-promote hook failed %s: %s", cg1_user_id, e)


async def delete_team(team_id: str, dry_run: bool = False, actor: str | None = None) -> dict:
    """Delete an OwnerIQ team (DELETE /v3/owner/teams/{id})."""
    if not dry_run and not writes_enabled():
        return {"ok": False, "error": _WRITES_OFF}
    team_id = clean_oid(team_id)
    if not team_id:
        return {"ok": False, "error": "team id must be a numeric OwnerIQ id."}
    async with httpx.AsyncClient(timeout=45.0) as client:
        tok = await _login(client)
        result = {"ok": True, "team_id": team_id, "dry_run": dry_run}
        if not dry_run:
            r = await client.delete(f"{B}/v3/owner/teams/{team_id}",
                                    headers={**_hdrs(tok), "accept": "application/vnd.api+json",
                                             "x-requested-with": "XMLHttpRequest"})
            if r.status_code not in (200, 204):
                result.update({"ok": False, "error": f"delete team failed: HTTP {r.status_code} {r.text[:150]}"})
    return result


async def hook_termination(cg1_user_id: str):
    """CG1 binned/soft-deleted a rep → deactivate them in OwnerIQ, and if they
    led a team, delete that team too."""
    if not writes_enabled():
        return
    try:
        res = await perform(cg1_user_id, "deactivate", dry_run=False, actor="auto:termination")
        logger.info("OwnerIQ auto-deactivate %s -> %s", cg1_user_id, res.get("after") or res.get("error"))
        from bson import ObjectId
        u = await db.users.find_one({"_id": ObjectId(cg1_user_id)}, {"owneriq_team_id": 1})
        if u and u.get("owneriq_team_id"):
            dr = await delete_team(u["owneriq_team_id"], actor="auto:termination")
            if dr.get("ok"):
                await db.users.update_one({"_id": ObjectId(cg1_user_id)}, {"$unset": {"owneriq_team_id": ""}})
            logger.info("OwnerIQ delete_team %s -> %s", u["owneriq_team_id"], "ok" if dr.get("ok") else dr.get("error"))
    except Exception as e:
        logger.error("OwnerIQ auto-deactivate hook failed %s: %s", cg1_user_id, e)


async def _leader_mc_id(leader_cg1_user_id: str) -> str | None:
    """Leader's office → OwnerIQ marketing_company_id (office → pin → the
    discovered company's id; see owneriq_config)."""
    from bson import ObjectId
    from owneriq_config import office_pin, company_id_for_pin
    try:
        u = await db.users.find_one({"_id": ObjectId(leader_cg1_user_id)}, {"office_id": 1})
    except Exception:
        return None
    if not u:
        return None
    return await company_id_for_pin(await office_pin(u.get("office_id")))


async def create_team(leader_cg1_user_id: str, team_name: str, dry_run: bool = False,
                      actor: str | None = None) -> dict:
    """Create a team in OwnerIQ led by this leader (POST /v3/owner/teams)."""
    if not dry_run and not writes_enabled():
        return {"ok": False, "error": _WRITES_OFF}
    async with httpx.AsyncClient(timeout=45.0) as client:
        tok = await _login(client)
        leader_oid = await resolve_owneriq_user_id(leader_cg1_user_id, client, tok)
        mc_id = await _leader_mc_id(leader_cg1_user_id)
        if not leader_oid:
            return {"ok": False, "error": "Coach not resolvable in OwnerIQ."}
        if not mc_id:
            return {"ok": False, "error": "Could not resolve the coach's office marketing_company_id."}
        result = {"ok": True, "leader_owneriq_id": leader_oid, "mc_id": mc_id,
                  "name": team_name, "dry_run": dry_run}
        if not dry_run:
            # multipart/form-data — (None, value) tuples make httpx send text fields.
            files = {
                "data[type]": (None, "teams"),
                "data[attributes][name]": (None, str(team_name)),
                "data[attributes][leader_id]": (None, str(leader_oid)),
                "data[attributes][marketing_company_id]": (None, str(mc_id)),
            }
            hdrs = {k: v for k, v in _hdrs(tok).items() if k != "content-type"}
            hdrs.update({"accept": "application/vnd.api+json", "x-requested-with": "XMLHttpRequest"})
            r = await client.post(f"{B}/v3/owner/teams", files=files, headers=hdrs)
            if r.status_code not in (200, 201):
                result.update({"ok": False, "error": f"create team failed: HTTP {r.status_code} {r.text[:150]}"})
            else:
                result["team_id"] = str((r.json().get("data", {}) or {}).get("id"))
    await db.owneriq_write_log.insert_one({
        "at": _now_iso(), "actor": actor, "cg1_user_id": leader_cg1_user_id,
        "action": "create_team", "team_name": team_name,
        "result": {k: result.get(k) for k in ("ok", "team_id", "error")},
    })
    return result


async def rename_team(team_id: str, team_name: str, dry_run: bool = False,
                      actor: str | None = None) -> dict:
    """Rename an OwnerIQ team (PATCH /v3/owner/teams/{id})."""
    if not dry_run and not writes_enabled():
        return {"ok": False, "error": _WRITES_OFF}
    team_id = clean_oid(team_id)
    if not team_id:
        return {"ok": False, "error": "team id must be a numeric OwnerIQ id."}
    async with httpx.AsyncClient(timeout=45.0) as client:
        tok = await _login(client)
        result = {"ok": True, "team_id": team_id, "name": team_name, "dry_run": dry_run}
        if not dry_run:
            files = {"data[attributes][name]": (None, str(team_name))}
            hdrs = {k: v for k, v in _hdrs(tok).items() if k != "content-type"}
            hdrs.update({"accept": "application/vnd.api+json", "x-requested-with": "XMLHttpRequest"})
            r = await client.patch(f"{B}/v3/owner/teams/{team_id}", files=files, headers=hdrs)
            if r.status_code not in (200, 204):
                result.update({"ok": False, "error": f"rename failed: HTTP {r.status_code} {r.text[:150]}"})
    return result


async def hook_team_name(leader_cg1_user_id: str, team_name: str):
    """CG1 leader named/renamed their team (Profile) → create the OwnerIQ team,
    or rename it if one already exists (owneriq_team_id stored on the user)."""
    if not writes_enabled() or not (team_name or "").strip():
        return
    from bson import ObjectId
    name = team_name.strip()
    try:
        u = await db.users.find_one({"_id": ObjectId(leader_cg1_user_id)}, {"owneriq_team_id": 1})
    except Exception:
        u = None
    try:
        if u and u.get("owneriq_team_id"):
            res = await rename_team(u["owneriq_team_id"], name, dry_run=False, actor="auto:team-name")
            logger.info("OwnerIQ rename_team %s -> %s", u["owneriq_team_id"], "ok" if res.get("ok") else res.get("error"))
        else:
            res = await create_team(leader_cg1_user_id, name, dry_run=False, actor="auto:team-name")
            if res.get("team_id"):
                await db.users.update_one({"_id": ObjectId(leader_cg1_user_id)},
                                          {"$set": {"owneriq_team_id": res["team_id"]}})
            logger.info("OwnerIQ create_team %s -> %s", leader_cg1_user_id, res.get("team_id") or res.get("error"))
    except Exception as e:
        logger.error("OwnerIQ team hook failed %s: %s", leader_cg1_user_id, e)


async def hook_leader_assignment(cg1_user_id: str, leader_cg1_user_id: str):
    """CG1 assigned a rep under a leader → move them under that leader in the
    OwnerIQ family tree (parent_id)."""
    if not writes_enabled() or not leader_cg1_user_id:
        return
    try:
        res = await reparent(cg1_user_id, leader_cg1_user_id, dry_run=False, actor="auto:reparent")
        logger.info("OwnerIQ auto-reparent %s under %s -> %s", cg1_user_id, leader_cg1_user_id,
                    res.get("after_parent") or res.get("error"))
    except Exception as e:
        logger.error("OwnerIQ reparent hook failed %s: %s", cg1_user_id, e)
