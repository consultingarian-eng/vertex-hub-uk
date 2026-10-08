"""Pre-publication hardening: one test (or a few) per fixed finding.

Each block names the rule it pins. Everything runs in memory (mongomock, fake
requests); nothing touches a network, OwnerIQ or a real database.
"""
import asyncio
import base64
import sys
from pathlib import Path

import pytest
from bson import ObjectId
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient
from starlette.requests import Request

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import auth  # noqa: E402
from core import bootstrap, rate_limit, webpush  # noqa: E402
from core.trainee_records import coach_hire_filter  # noqa: E402
from models import UpdateUserNameRequest  # noqa: E402
from routes import (  # noqa: E402
    admin_routes, agenda, auth_routes, bells, coaching, leader_today,
    manual_editor, owneriq as owneriq_routes, reports, roster_share,
)
import owneriq_sync  # noqa: E402
import owneriq_write  # noqa: E402

OFFICE = "office-a"
OTHER = "office-b"


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _request(headers=None, client="10.0.0.9", path="/test"):
    pairs = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request({"type": "http", "method": "GET", "path": path, "query_string": b"",
                    "headers": pairs, "client": (client, 5000), "server": ("test", 443),
                    "scheme": "https"}, receive)


def _json_request(body: dict, client="10.0.0.9"):
    import json
    raw = json.dumps(body).encode()
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": raw, "more_body": False}

    return Request({"type": "http", "method": "PUT", "path": "/test", "query_string": b"",
                    "headers": [(b"content-type", b"application/json")], "client": (client, 5000),
                    "server": ("test", 443), "scheme": "https"}, receive)


@pytest.fixture()
def db(monkeypatch):
    database = AsyncMongoMockClient()["hardening_test"]
    for module in (auth, admin_routes, agenda, auth_routes, bells, coaching, leader_today,
                   owneriq_routes, reports, owneriq_sync, owneriq_write, roster_share):
        monkeypatch.setattr(module, "db", database)
    return database


def _user(db, name, role, office=OFFICE, reports_to=None, **extra):
    doc = {"_id": ObjectId(), "name": name, "role": role, "office_id": office,
           "reports_to": str(reports_to["_id"]) if reports_to else None, **extra}
    _run(db.users.insert_one(doc))
    return {**doc, "id": str(doc["_id"])}


def _as(monkeypatch, user, *modules):
    """Sign in as `user`: the real require_admin / require_super_admin run on top."""
    async def current(_request):
        if user is None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return dict(user)
    monkeypatch.setattr(auth, "get_current_user", current)
    for m in modules:
        if hasattr(m, "get_current_user"):
            monkeypatch.setattr(m, "get_current_user", current)


# ── #1 offices list + Bells share codes ─────────────────────────────────

def test_offices_list_needs_login_and_never_returns_the_share_code(db, monkeypatch):
    _run(db.offices.insert_one({"id": OFFICE, "name": "Leeds", "city": "Leeds", "state": "",
                                "bells_share_code": "secret-share-code-xyz", "weekly_goal": 40}))
    _as(monkeypatch, None, admin_routes)
    with pytest.raises(HTTPException) as err:
        _run(admin_routes.get_offices(_request()))
    assert err.value.status_code == 401
    _as(monkeypatch, {"id": "u1", "role": "trainee", "office_id": OFFICE}, admin_routes)
    rows = _run(admin_routes.get_offices(_request()))
    assert rows == [{"id": OFFICE, "name": "Leeds", "city": "Leeds", "state": ""}]


def test_share_code_is_generated_long_typed_codes_need_16_and_can_be_cleared(db, monkeypatch):
    _run(db.offices.insert_one({"id": OFFICE, "name": "Leeds"}))
    _as(monkeypatch, {"id": "o", "role": "admin", "is_super_admin": True}, bells)
    out = _run(bells.set_share_code(OFFICE, _json_request({"generate": True})))
    assert len(out["share_code"]) >= 22
    with pytest.raises(HTTPException) as err:
        _run(bells.set_share_code(OFFICE, _json_request({"share_code": "office2026"})))
    assert err.value.status_code == 400
    ok = _run(bells.set_share_code(OFFICE, _json_request({"share_code": "a-typed-code-of-20ch"})))
    assert ok["share_code"] == "a-typed-code-of-20ch"
    cleared = _run(bells.set_share_code(OFFICE, _json_request({"share_code": ""})))
    assert cleared["share_code"] is None
    assert "bells_share_code" not in _run(db.offices.find_one({"id": OFFICE}))
    # Office admins can't set codes at all.
    _as(monkeypatch, {"id": "a", "role": "admin", "office_id": OFFICE}, bells)
    with pytest.raises(HTTPException) as err:
        _run(bells.set_share_code(OFFICE, _json_request({"generate": True})))
    assert err.value.status_code == 403


def test_public_bells_wrong_codes_are_throttled_and_short_legacy_codes_are_off(db, monkeypatch):
    monkeypatch.setattr(bells, "_SHARE_CODE_FAILURES", rate_limit.Limiter(3, 900))
    _run(db.offices.insert_one({"id": OFFICE, "name": "Leeds", "bells_share_code": "x" * 22}))
    req = _request(client="203.0.113.5")
    for _ in range(3):
        with pytest.raises(HTTPException) as err:
            _run(bells._public_bells_payload("leeds", None, "guess", req))
        assert err.value.status_code == 401
    with pytest.raises(HTTPException) as err:   # even the right code, once throttled
        _run(bells._public_bells_payload("leeds", None, "x" * 22, req))
    assert err.value.status_code == 429
    # Another address is unaffected and the right code works.
    office, *_ = _run(bells._public_bells_payload("leeds", None, "x" * 22, _request(client="198.51.100.7")))
    assert office["id"] == OFFICE
    # A 4-character code saved before the rule no longer opens anything.
    _run(db.offices.update_one({"id": OFFICE}, {"$set": {"bells_share_code": "abcd"}}))
    with pytest.raises(HTTPException) as err:
        _run(bells._public_bells_payload("leeds", None, "abcd", _request(client="192.0.2.1")))
    assert err.value.status_code == 403


# ── #2 Live Operations ids ──────────────────────────────────────────────

@pytest.mark.parametrize("bad", ["1/../../users", "12?x=1", "abc", "", "1.5", "9" * 21])
def test_live_ids_are_digits_only(bad):
    with pytest.raises(HTTPException) as err:
        owneriq_routes._live_id(bad, "ba_id")
    assert err.value.status_code == 400
    assert owneriq_routes._live_id(" 4521 ", "ba_id") == "4521"


def test_live_date_must_be_iso():
    with pytest.raises(HTTPException):
        owneriq_routes._live_date("2026-10-01/../x")
    assert owneriq_routes._live_date("2026-10-01") == "2026-10-01"


def test_ba_detail_fails_closed_without_a_sector(db, monkeypatch):
    coach = _user(db, "Coach", "leader")
    _as(monkeypatch, coach, owneriq_routes)

    async def fake_ba(ba_id, iso, force=False):
        return {"ba": {"id": int(ba_id), "full_name": "Coach"}, "sector": None}
    monkeypatch.setattr(owneriq_routes, "get_ba", fake_ba)
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_live_ba(_request(), "77", date="2026-10-01"))
    assert err.value.status_code == 403
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_live_ba(_request(), "77/../sectors/1", date="2026-10-01"))
    assert err.value.status_code == 400


# ── #3 names are display only ───────────────────────────────────────────

def test_rename_to_a_name_used_in_the_office_is_refused(db, monkeypatch):
    _user(db, "Sam  Example", "leader")
    _user(db, "Alex Other", "trainee", office=OTHER)
    me = _user(db, "New Person", "trainee")
    _as(monkeypatch, me, admin_routes)
    for clash in ("sam example", "  SAM   EXAMPLE "):
        with pytest.raises(HTTPException) as err:
            _run(admin_routes.update_my_name(UpdateUserNameRequest(name=clash), _request()))
        assert err.value.status_code == 409
    # A name used only in another office is fine, and so is re-casing your own.
    assert _run(admin_routes.update_my_name(UpdateUserNameRequest(name="Alex Other"), _request()))["name"] == "Alex Other"
    me["name"] = "Alex Other"
    _as(monkeypatch, me, admin_routes)
    assert _run(admin_routes.update_my_name(UpdateUserNameRequest(name="alex other"), _request()))["name"] == "alex other"


def test_hire_without_account_is_opened_by_coach_id_not_name(db, monkeypatch):
    real = _user(db, "Dana Example", "leader")
    impostor = _user(db, "Dana Example", "leader")   # same display name, unrelated
    _run(db.new_hires.insert_one({"id": "h1", "office_id": OFFICE, "leader": "Dana Example",
                                  "leader_user_id": real["id"], "trainee_user_id": None}))
    assert _run(auth.can_access_hire(real, "h1")) is True
    assert _run(auth.can_access_hire(impostor, "h1")) is False
    # The list filter: id first; the name only reaches legacy rows with no ids.
    flt = coach_hire_filter([], [impostor["id"]], ["Dana Example"])
    _run(db.new_hires.insert_one({"id": "legacy", "office_id": OFFICE, "leader": "Dana Example"}))
    got = sorted(h["id"] for h in _run(db.new_hires.find({"$or": flt}).to_list(10)))
    assert got == ["legacy"]


# ── #4 OwnerIQ rep-action / reconcile ───────────────────────────────────

def test_rep_action_is_office_scoped_and_raw_ids_are_owner_only(db, monkeypatch):
    admin = _user(db, "Office Admin", "admin")
    foreign = _user(db, "Elsewhere", "trainee", office=OTHER)
    _as(monkeypatch, admin, owneriq_routes)

    async def boom(*_a, **_k):
        raise AssertionError("OwnerIQ must not be called")
    monkeypatch.setattr(owneriq_write, "perform", boom)
    monkeypatch.setattr(owneriq_write, "reparent", boom)
    body = owneriq_routes.RepActionBody(cg1_user_id=foreign["id"], action="promote")
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_rep_action(_request(), body))
    assert err.value.status_code == 403
    raw = owneriq_routes.RepActionBody(owneriq_user_id="123", action="promote")
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_rep_action(_request(), raw))
    assert err.value.status_code == 403
    owner = _user(db, "Owner", "admin", is_super_admin=True)
    _as(monkeypatch, owner, owneriq_routes)
    bad = owneriq_routes.RepActionBody(owneriq_user_id="12/../99", action="promote")
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_rep_action(_request(), bad))
    assert err.value.status_code == 400


def test_reconcile_is_owner_only(db, monkeypatch):
    _as(monkeypatch, _user(db, "Office Admin", "admin"), owneriq_routes)
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_reconcile(_request(), dry_run=True))
    assert err.value.status_code == 403


def test_every_owneriq_write_checks_the_switch_itself(monkeypatch):
    monkeypatch.delenv("OWNERIQ_WRITES_ENABLED", raising=False)

    async def no_login(*_a, **_k):
        raise AssertionError("must not log in to OwnerIQ")
    monkeypatch.setattr(owneriq_write, "_login", no_login)
    for call in (owneriq_write.perform("x", "promote", dry_run=False),
                 owneriq_write.reparent("x", "y", dry_run=False),
                 owneriq_write.delete_team("12", dry_run=False),
                 owneriq_write.create_team("x", "Team", dry_run=False),
                 owneriq_write.rename_team("12", "Team", dry_run=False)):
        out = _run(call)
        assert out["ok"] is False and "OWNERIQ_WRITES_ENABLED" in out["error"]
    assert owneriq_write.clean_oid("42") == "42"
    assert owneriq_write.clean_oid("4/2") is None and owneriq_write.clean_oid(None) is None


# ── #5 coaching resources ───────────────────────────────────────────────

def test_coaching_uploads_must_be_pdfs_and_links_https():
    assert coaching._require_pdf(b"%PDF-1.7\n...") == b"%PDF-1.7\n..."
    for bad in (b"<html><script>alert(1)</script>", b"<svg onload=x>", b""):
        with pytest.raises(HTTPException):
            coaching._require_pdf(bad)
    assert coaching._clean_link("https://www.youtube.com/watch?v=abc") == "https://www.youtube.com/watch?v=abc"
    for bad in ("javascript:alert(1)", "data:text/html,<b>x</b>", "http://example.org", "https://",
                "https://exa mple.org", "//example.org"):
        with pytest.raises(HTTPException):
            coaching._clean_link(bad)


def test_stored_resources_are_served_as_pdf_and_bad_links_withheld():
    pdf = coaching._serialize_resource({"id": "r1", "type": "pdf", "mime_type": "text/html"})
    assert pdf["mime_type"] == "application/pdf"
    link = coaching._serialize_resource({"id": "r2", "type": "link", "link_url": "javascript:alert(1)"})
    assert link["link_url"] is None


def test_create_resource_refuses_an_html_file_labelled_pdf(db, monkeypatch):
    _as(monkeypatch, {"id": "a", "role": "admin", "office_id": OFFICE}, coaching)
    body = coaching.ResourceCreate(title="Handout", type="pdf", mime_type="text/html",
                                   file_b64=base64.b64encode(b"<html><script>x</script>").decode())
    with pytest.raises(HTTPException) as err:
        _run(coaching.create_resource(body, _request()))
    assert err.value.status_code == 400


# ── #6 reports are office-scoped ────────────────────────────────────────

def test_reports_refuse_people_and_names_from_another_office(db, monkeypatch):
    admin = _user(db, "Office Admin", "admin")
    foreign = _user(db, "Far Away", "trainee", office=OTHER)
    _as(monkeypatch, admin, reports)
    for body in (reports.ReportBody(scope="individual", user_id=foreign["id"], ai=False),
                 reports.ReportBody(scope="team", leader_id=foreign["id"], ai=False)):
        with pytest.raises(HTTPException) as err:
            _run(reports.generate_report(_request(), body))
        assert err.value.status_code == 403
    assert _run(reports._resolve_individual("Far Away", reports._office_filter(admin))) is None
    assert _run(reports._resolve_individual("Far Away", {}))[0] == foreign["id"]


# ── #7 OwnerIQ manual sync ──────────────────────────────────────────────

def test_manual_sync_is_admin_only_capped_and_cooled_down(db, monkeypatch):
    calls = []

    async def fake_sync(a, b):
        calls.append((a, b))
        return {"ok": True}
    monkeypatch.setattr(owneriq_routes, "sync_owneriq", fake_sync)
    monkeypatch.setattr(owneriq_routes, "_last_manual_sync", 0.0)
    _as(monkeypatch, _user(db, "Coach", "leader"), owneriq_routes)
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_sync_now(_request(), owneriq_routes.SyncBody()))
    assert err.value.status_code == 403
    _as(monkeypatch, _user(db, "Admin", "admin"), owneriq_routes)
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_sync_now(_request(), owneriq_routes.SyncBody(from_date="2026-09-01", to_date="2026-09-30")))
    assert err.value.status_code == 400
    ok = owneriq_routes.SyncBody(from_date="2026-09-17", to_date="2026-09-30")   # 14 days
    assert _run(owneriq_routes.owneriq_sync_now(_request(), ok)) == {"ok": True}
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_sync_now(_request(), ok))
    assert err.value.status_code == 429
    assert len(calls) == 1


# ── #8 client IP + the shared editor password ───────────────────────────

def test_client_ip_uses_the_rightmost_forwarded_hop(monkeypatch):
    spoofed = {"x-forwarded-for": "1.2.3.4, 203.0.113.9"}
    monkeypatch.delenv("TRUST_PROXY_HEADERS", raising=False)
    monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME", raising=False)
    assert rate_limit.client_ip(_request(spoofed, client="10.1.1.1")) == "10.1.1.1"
    monkeypatch.setenv("TRUST_PROXY_HEADERS", "true")
    assert rate_limit.client_ip(_request(spoofed, client="10.1.1.1")) == "203.0.113.9"
    assert rate_limit.client_ip(_request({"x-forwarded-for": "198.51.100.2"})) == "198.51.100.2"
    assert rate_limit.client_ip(_request(client="10.1.1.1")) == "10.1.1.1"
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "2")
    assert rate_limit.client_ip(_request(spoofed)) == "1.2.3.4"
    # The login limiter keys on the same address.
    monkeypatch.delenv("TRUSTED_PROXY_HOPS")
    assert auth_routes._request_ip(_request(spoofed)) == "203.0.113.9"


def test_short_editor_password_keeps_the_shared_editor_off(monkeypatch):
    monkeypatch.setenv("MANUAL_EDITOR_PASSWORD", "short-pass")
    assert manual_editor._expected_password() == ""
    monkeypatch.setenv("MANUAL_EDITOR_PASSWORD", "a" * 16)
    assert manual_editor._expected_password() == "a" * 16


def test_editor_password_has_a_global_failure_cap(monkeypatch):
    monkeypatch.setenv("MANUAL_EDITOR_PASSWORD", "correct-horse-battery-staple")
    monkeypatch.setattr(manual_editor, "_auth_failures", {})
    monkeypatch.setattr(manual_editor, "GLOBAL_MAX_FAILURES", 6)
    # Wrong guesses spread over many addresses (2 each, under the per-IP cap).
    for i in range(3):
        for _ in range(2):
            with pytest.raises(HTTPException) as err:
                _run(manual_editor.auth_verify(manual_editor.AuthBody(password="nope"), _request(client=f"198.51.100.{i}")))
            assert err.value.status_code == 401
    with pytest.raises(HTTPException) as err:   # now locked for everyone, right password included
        _run(manual_editor.auth_verify(manual_editor.AuthBody(password="correct-horse-battery-staple"), _request(client="192.0.2.50")))
    assert err.value.status_code == 429


# ── #9 AI quota ─────────────────────────────────────────────────────────

def test_ai_quota_is_per_person_per_hour(monkeypatch):
    monkeypatch.setattr(rate_limit, "AI_QUOTA", rate_limit.Limiter(3, 3600))
    for _ in range(3):
        rate_limit.take_ai_quota({"id": "u1"})
    with pytest.raises(HTTPException) as err:
        rate_limit.take_ai_quota({"id": "u1"})
    assert err.value.status_code == 429
    rate_limit.take_ai_quota({"id": "u2"})   # someone else is unaffected


def test_ai_routes_charge_the_quota_before_calling_the_model(db, monkeypatch):
    monkeypatch.setattr(rate_limit, "AI_QUOTA", rate_limit.Limiter(0, 3600))
    admin = _user(db, "Admin", "admin")
    _as(monkeypatch, admin, reports)

    async def no_ai(*_a, **_k):
        raise AssertionError("the model must not be called")
    monkeypatch.setattr(reports, "parse_intent", no_ai)
    with pytest.raises(HTTPException) as err:
        _run(reports.generate_from_prompt(_request(), reports.PromptBody(text="Team report for July")))
    assert err.value.status_code == 429


# ── #10 web push endpoints ──────────────────────────────────────────────

def test_push_endpoints_must_be_known_push_services():
    good = ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x",
            "https://web.push.apple.com/QGx", "https://wns2-par02p.notify.windows.com/w/?token=x"]
    bad = ["http://fcm.googleapis.com/fcm/send/abc", "https://169.254.169.254/latest", "https://localhost/x",
           "https://fcm.googleapis.com.evil.example/x", "https://evilfcm.googleapis.com.example/x",
           "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "", "x" * 2000]
    assert all(webpush.is_allowed_push_endpoint(u) for u in good)
    assert not any(webpush.is_allowed_push_endpoint(u) for u in bad)


# ── #11 starter-password status ─────────────────────────────────────────

def test_starter_status_shows_an_office_admin_their_office_only(db, monkeypatch):
    _user(db, "Here", "trainee", must_change_password=True)
    _user(db, "There", "trainee", office=OTHER, must_change_password=True)
    _as(monkeypatch, _user(db, "Admin", "admin"), auth_routes)
    out = _run(auth_routes.starter_password_status(_request()))
    assert [w["name"] for w in out["waiting"]] == ["Here"]
    _as(monkeypatch, _user(db, "Owner", "admin", is_super_admin=True), auth_routes)
    out = _run(auth_routes.starter_password_status(_request()))
    assert sorted(w["name"] for w in out["waiting"]) == ["Here", "There"]


# ── #12 roster share token ──────────────────────────────────────────────

def test_roster_token_needs_32_characters_and_wrong_tokens_are_throttled(monkeypatch):
    monkeypatch.setenv("ROSTER_SHARE_TOKEN", "too-short-token")
    with pytest.raises(HTTPException) as err:
        roster_share._check_token("too-short-token", _request())
    assert err.value.status_code == 404
    token = "t" * 40
    monkeypatch.setenv("ROSTER_SHARE_TOKEN", token)
    monkeypatch.setattr(roster_share, "_TOKEN_FAILURES", rate_limit.Limiter(2, 900))
    roster_share._check_token(token, _request())
    for _ in range(2):
        with pytest.raises(HTTPException) as err:
            roster_share._check_token("wrong", _request(client="203.0.113.77"))
        assert err.value.status_code == 404
    with pytest.raises(HTTPException) as err:
        roster_share._check_token(token, _request(client="203.0.113.77"))
    assert err.value.status_code == 429


# ── #13 seed status ─────────────────────────────────────────────────────

def test_seed_status_is_admin_only_on_both_paths(db, monkeypatch):
    _as(monkeypatch, None, admin_routes)
    for route in (admin_routes.health_seed_status, admin_routes.admin_seed_status):
        with pytest.raises(HTTPException) as err:
            _run(route(_request()))
        assert err.value.status_code == 401
    _as(monkeypatch, _user(db, "Coach", "leader"), admin_routes)
    with pytest.raises(HTTPException) as err:
        _run(admin_routes.health_seed_status(_request()))
    assert err.value.status_code == 403
    _as(monkeypatch, _user(db, "Admin", "admin"), admin_routes)
    out = _run(admin_routes.health_seed_status(_request()))
    assert "seed_dir_path" not in out


# ── #14 agenda publish + coach nudge ────────────────────────────────────

def test_agenda_publish_and_coach_nudge_stay_in_the_admins_office(db, monkeypatch):
    _run(db.weekly_agendas.insert_one({"id": "ag1", "office_id": OTHER, "rows": [], "status": "draft"}))
    coach = _user(db, "Other Coach", "leader", office=OTHER)
    _as(monkeypatch, _user(db, "Admin", "admin"), agenda, leader_today)
    with pytest.raises(HTTPException) as err:
        _run(agenda.publish_agenda("ag1", _request()))
    assert err.value.status_code == 404
    assert _run(db.weekly_agendas.find_one({"id": "ag1"}))["status"] == "draft"

    async def no_push(*_a, **_k):
        raise AssertionError("no push across offices")
    monkeypatch.setattr(leader_today, "send_push_to_user", no_push)
    with pytest.raises(HTTPException) as err:
        _run(leader_today.remind_leader(coach["id"], _request()))
    assert err.value.status_code == 404


# ── #15 owner password ──────────────────────────────────────────────────

def test_admin_password_seeds_once_and_resets_only_on_request(monkeypatch):
    database = AsyncMongoMockClient()["hardening_boot"]
    monkeypatch.setenv("ADMIN_EMAIL", "owner@example.org")
    monkeypatch.setenv("ADMIN_PASSWORD", "first-password-123")
    monkeypatch.delenv("ADMIN_PASSWORD_RESET", raising=False)
    _run(bootstrap.seed_admin(database))
    # The owner changes their password in the app…
    _run(database.users.update_one({"email": "owner@example.org"},
                                   {"$set": {"password_hash": auth.hash_password("changed-in-app-456")}}))
    _run(bootstrap.seed_admin(database))   # …and a redeploy leaves it alone.
    u = _run(database.users.find_one({"email": "owner@example.org"}))
    assert auth.verify_password("changed-in-app-456", u["password_hash"])
    monkeypatch.setenv("ADMIN_PASSWORD_RESET", "true")
    _run(bootstrap.seed_admin(database))
    u = _run(database.users.find_one({"email": "owner@example.org"}))
    assert auth.verify_password("first-password-123", u["password_hash"])
    assert u["session_version"] == 1


# ── config: one model setting, one database ─────────────────────────────

def test_model_comes_from_one_setting(monkeypatch):
    from emergentintegrations.llm import chat
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    monkeypatch.delenv("ANTHROPIC_VISION_MODEL", raising=False)
    assert chat.LlmChat().with_model("anthropic", "claude-some-old-id").model == "claude-sonnet-5-5"
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-opus-5-5")
    assert chat.LlmChat().with_model("anthropic").model == "claude-opus-5-5"
    assert chat.LlmChat().with_model("vision").model == "claude-opus-5-5"
    monkeypatch.setenv("ANTHROPIC_VISION_MODEL", "claude-haiku-4-5")
    assert chat.LlmChat().with_model("vision").model == "claude-haiku-4-5"


def test_no_call_site_names_a_model_or_opens_its_own_database():
    import re
    for path in BACKEND_DIR.rglob("*.py"):
        rel = path.relative_to(BACKEND_DIR).as_posix()
        if rel.startswith(("tests/", "venv", ".venv")) or "site-packages" in rel:
            continue
        text = path.read_text(encoding="utf-8")
        if rel != "emergentintegrations/llm/chat.py":
            assert not re.search(r"""["']claude-[a-z0-9-]+["']""", text), f"model id hard-coded in {rel}"
        if rel != "database.py":
            assert "AsyncIOMotorClient(" not in text, f"{rel} opens its own Mongo client"


# ── #16 CORS on a hosted deploy ─────────────────────────────────────────

def test_hosted_deploy_has_no_localhost_cors_default():
    import os
    import subprocess
    base = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""),
            "JWT_SECRET": "example-secret-0123456789abcdef0123456789abcdef",
            "MONGO_URL": "mongodb://127.0.0.1:1/unused", "DB_NAME": "hardening_unused"}
    if os.environ.get("SYSTEMROOT"):
        base["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    code = "import server; print(server._cors_origins)"
    hosted = subprocess.run([sys.executable, "-c", code], cwd=BACKEND_DIR, capture_output=True, text=True,
                            timeout=120, env={**base, "RAILWAY_ENVIRONMENT": "production"})
    assert hosted.returncode == 0, hosted.stderr[-2000:]
    assert hosted.stdout.strip().splitlines()[-1] == "[]"
    local = subprocess.run([sys.executable, "-c", code], cwd=BACKEND_DIR, capture_output=True, text=True,
                           timeout=120, env=base)
    assert "localhost:8081" in local.stdout


def test_a_name_two_live_accounts_share_links_nobody(db):
    a = _user(db, "Jo Sample", "trainee")
    _user(db, "Jo  sample", "trainee", office=OTHER)         # cross-office namesake
    gone = _user(db, "Twin Example", "trainee", deleted=True)     # a deleted twin doesn't count
    back = _user(db, "Twin Example", "trainee")
    _, by_name = _run(owneriq_sync._build_rep_resolvers())
    assert "jo sample" not in by_name
    assert by_name["twin example"] == back["id"] and gone["id"] != back["id"]
    assert a["id"] not in by_name.values()


# ── Gate re-check: a name match never authorises ───────────────────────

def _fake_owneriq(monkeypatch, rows):
    async def fake_login(_client):
        return "tok"

    async def fake_fetch(_client, _token, _a, _b):
        return [dict(r) for r in rows]
    monkeypatch.setattr(owneriq_sync, "_login", fake_login)
    monkeypatch.setattr(owneriq_sync, "_fetch_all_companies", fake_fetch)


def test_renaming_to_an_unlinked_owneriq_reps_name_grants_nothing(db, monkeypatch):
    import owneriq_hub
    monkeypatch.setattr(owneriq_hub, "db", db)
    me = _user(db, "New Starter", "trainee")
    _as(monkeypatch, me, admin_routes, owneriq_routes)
    # Nobody in the app holds the OwnerIQ leader's name, so the rename is allowed.
    _run(admin_routes.update_my_name(UpdateUserNameRequest(name="Rhys Placeholder"), _request()))
    me["name"] = "Rhys Placeholder"
    _fake_owneriq(monkeypatch, [
        {"owneriq_id": "k1", "owneriq_user_id": 9001, "badge_number": "ZZ-1", "rep_name": "Rhys  Placeholder",
         "date": "2026-10-07", "mc_pin": "P1", "sales": 3},
        {"owneriq_id": "k2", "owneriq_user_id": 9002, "badge_number": "ZZ-2", "rep_name": "Team Member",
         "date": "2026-10-07", "mc_pin": "P1", "sales": 1},
    ])
    summary = _run(owneriq_sync.sync_owneriq("2026-10-07", "2026-10-07"))
    assert summary["reps_matched"] == 0
    row = _run(db.owneriq_kpis.find_one({"_id": "k1"}))
    assert row["cg1_user_id"] is None and row["cg1_matched_by"] is None
    assert row["cg1_suggested_user_id"] == me["id"]          # a display hint only

    _, _, caller_oids = _run(owneriq_routes._live_link_ctx(me))
    assert caller_oids == set()
    sector = {"members": [{"id": 9001, "full_name": "Rhys Placeholder", "is_leader": True},
                          {"id": 9002, "full_name": "Team Member"}]}
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes._assert_sector_visible(me, sector))
    assert err.value.status_code == 403
    assert _run(owneriq_routes._scoped_rows(me, "2026-10-01", "2026-10-08")) == []
    assert _run(owneriq_hub.app_user_ids({"users": [{"user": {"id": 9001}}]})) == {}
    assert _run(owneriq_write.resolve_owneriq_user_id(me["id"], None, "tok")) is None

    # A badge link (set by an admin) does link, and then the sector opens.
    _run(db.users.update_one({"_id": me["_id"]}, {"$set": {"amplifi_codes": ["ZZ-1"]}}))
    _run(owneriq_sync.sync_owneriq("2026-10-07", "2026-10-07"))
    assert _run(db.owneriq_kpis.find_one({"_id": "k1"}))["cg1_matched_by"] == "badge"
    _run(owneriq_routes._assert_sector_visible(me, sector))


def test_name_links_from_older_versions_stop_authorising(db, monkeypatch):
    me = _user(db, "New Starter", "trainee")
    _run(db.owneriq_kpis.insert_many([
        {"_id": "old", "owneriq_user_id": 9001, "cg1_user_id": me["id"], "cg1_matched_by": "name",
         "date": "2026-10-06", "mc_pin": "P1"},
        {"_id": "ok", "owneriq_user_id": 9003, "cg1_user_id": me["id"], "cg1_matched_by": "badge",
         "date": "2026-10-06", "mc_pin": "P1"},
    ]))
    # Even before the next sync rewrites them, readers ignore name links.
    _, _, caller_oids = _run(owneriq_routes._live_link_ctx(me))
    assert caller_oids == {"9003"}
    assert [r["owneriq_user_id"] for r in _run(owneriq_routes._scoped_rows(me, "2026-10-01", "2026-10-08"))] == [9003]
    assert _run(owneriq_sync.retire_name_links()) == 1
    old = _run(db.owneriq_kpis.find_one({"_id": "old"}))
    assert old["cg1_user_id"] is None and old["cg1_suggested_user_id"] == me["id"]
    assert _run(db.owneriq_kpis.find_one({"_id": "ok"}))["cg1_user_id"] == me["id"]


# ── Gate re-check: manual sync ranges are checked after defaults ───────

def test_sync_range_is_capped_after_defaults_and_never_runs_into_the_future(monkeypatch):
    from datetime import date as _date, timedelta as _td
    today = owneriq_routes.datetime.now(owneriq_routes.APP_TZ).date()
    for a, b in (("2015-01-01", None), ("2015-01-01", "2030-01-01")):
        with pytest.raises(HTTPException) as err:
            owneriq_routes._resolve_sync_range(a, b)
        assert err.value.status_code == 400
    # A far-future `to` is pulled back to today; `from` defaults to the day before.
    assert owneriq_routes._resolve_sync_range(None, "2099-01-01") == \
        ((today - _td(days=1)).isoformat(), today.isoformat())
    assert owneriq_routes._resolve_sync_range("2099-01-01", None) is None
    future_end = (today + _td(days=5)).isoformat()
    a = (today - _td(days=8)).isoformat()
    assert owneriq_routes._resolve_sync_range(a, future_end) == (a, today.isoformat())
    for bad in ("2026-10-08\n", "٢٠٢٦-١٠-٠٨", "2026-02-30", "20261008"):
        with pytest.raises(HTTPException) as err:
            owneriq_routes._resolve_sync_range(bad, None)
        assert err.value.status_code == 400
    assert isinstance(_date.fromisoformat(today.isoformat()), _date)


def test_performance_sync_shares_the_cooldown_and_long_backfills_are_owner_only(db, monkeypatch):
    import owneriq_performance
    calls = []

    async def fake_perf(weeks, bells_weeks):
        calls.append(("perf", weeks, bells_weeks))
        return {"ok": True}

    async def fake_sync(a, b):
        calls.append(("kpi", a, b))
        return {"ok": True}
    monkeypatch.setattr(owneriq_performance, "sync_performance", fake_perf)
    monkeypatch.setattr(owneriq_routes, "sync_owneriq", fake_sync)
    monkeypatch.setattr(owneriq_routes, "_last_manual_sync", 0.0)
    _as(monkeypatch, _user(db, "Admin", "admin"), owneriq_routes)
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes.owneriq_performance_sync(_request(), weeks=2, bells_weeks=8))
    assert err.value.status_code == 403
    assert _run(owneriq_routes.owneriq_performance_sync(_request(), weeks=2, bells_weeks=2)) == {"ok": True}
    with pytest.raises(HTTPException) as err:    # the KPI sync shares the same slot
        _run(owneriq_routes.owneriq_sync_now(_request(), owneriq_routes.SyncBody()))
    assert err.value.status_code == 429
    monkeypatch.setattr(owneriq_routes, "_last_manual_sync", 0.0)
    _as(monkeypatch, _user(db, "Owner", "admin", is_super_admin=True), owneriq_routes)
    assert _run(owneriq_routes.owneriq_performance_sync(_request(), weeks=2, bells_weeks=8)) == {"ok": True}
    assert [c[0] for c in calls] == ["kpi", "perf", "kpi", "perf"]


# ── Gate re-check: ids and dates are ASCII ─────────────────────────────

@pytest.mark.parametrize("bad", ["²", "١٢٣", "1\n2", "１２"])   # (surrounding spaces are stripped)
def test_owneriq_ids_are_ascii_digits_only(bad):
    with pytest.raises(HTTPException):
        owneriq_routes._live_id(bad, "ba_id")
    assert owneriq_write.clean_oid(bad) is None
    assert not owneriq_sync.is_oid(bad)
    assert owneriq_sync.is_oid("4521") and owneriq_write.clean_oid(4521) == "4521"


@pytest.mark.parametrize("bad", ["2026-10-08\n", "٢٠٢٦-١٠-٠٨", "2026-13-01", "2026-10-8"])
def test_live_dates_are_ascii_calendar_days(bad):
    with pytest.raises(HTTPException) as err:
        owneriq_routes._live_date(bad)
    assert err.value.status_code == 400


# ── Gate re-check: link-debug is office-scoped ─────────────────────────

def test_link_debug_shows_an_office_admin_their_office_only(db, monkeypatch):
    _run(db.offices.insert_many([{"id": OFFICE, "name": "Leeds", "owneriq_pin": "P1"},
                                 {"id": OTHER, "name": "York", "owneriq_pin": "P2"}]))
    _user(db, "Far Person", "trainee", office=OTHER)
    _run(db.owneriq_kpis.insert_many([
        {"_id": "a", "mc_pin": "P1", "rep_name": "Near Rep", "badge_number": "N1", "cg1_user_id": None},
        {"_id": "b", "mc_pin": "P2", "rep_name": "Far Rep", "badge_number": "F1", "cg1_user_id": None},
    ]))
    _as(monkeypatch, _user(db, "Admin", "admin"), owneriq_routes)
    out = _run(owneriq_routes.owneriq_link_debug(_request()))
    assert out["owneriq_rows_total"] == 1 and out["app_users_total"] == 1
    assert [s["rep_name"] for s in out["unlinked_samples"]] == ["Near Rep"]
    _as(monkeypatch, _user(db, "Owner", "admin", is_super_admin=True), owneriq_routes)
    assert _run(owneriq_routes.owneriq_link_debug(_request()))["owneriq_rows_total"] == 2


# ── Gate re-check: AI quota gaps ───────────────────────────────────────

def test_a_failed_quiz_generation_is_charged_and_not_retried_for_an_hour(db, monkeypatch):
    monkeypatch.setattr(rate_limit, "AI_QUOTA", rate_limit.Limiter(10, 3600))
    monkeypatch.setattr(rate_limit, "_GENERATION_ATTEMPTS", rate_limit.Limiter(1, 3600))
    calls = []

    async def failing(*_a, **_k):
        calls.append(1)
        return None
    monkeypatch.setattr(coaching, "_generate_impact_quiz_questions", failing)
    impact = {"id": "imp-gate", "title": "Pacing", "body": "x " * 80, "key_takeaways": ["Slow down"]}
    user = {"id": "u-quiz", "role": "leader"}
    for _ in range(3):
        assert _run(coaching._get_or_create_impact_quiz(impact, user)) is None
    assert len(calls) == 1
    assert len(rate_limit.AI_QUOTA._recent("ai:u-quiz")) == 1


def test_module_quiz_generation_charges_the_requester(db, monkeypatch):
    from routes import modules
    monkeypatch.setattr(modules, "db", db)
    monkeypatch.setattr(rate_limit, "AI_QUOTA", rate_limit.Limiter(0, 3600))
    monkeypatch.setattr(rate_limit, "_GENERATION_ATTEMPTS", rate_limit.Limiter(1, 3600))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-placeholder-not-a-key")
    import emergentintegrations.llm.chat as chat_mod

    class NoModel:
        def __init__(self, *_a, **_k):
            raise AssertionError("the model must not be called")
    monkeypatch.setattr(chat_mod, "LlmChat", NoModel)
    m = {"id": "mod-gate", "topic": "Doors", "trainee_content": "y " * 80, "what_good_looks_like": []}
    with pytest.raises(HTTPException) as err:
        _run(modules._get_or_create_quiz(m, {"id": "u-mod"}))
    assert err.value.status_code == 429


def test_prompt_reports_charge_two_units(db, monkeypatch):
    monkeypatch.setattr(rate_limit, "AI_QUOTA", rate_limit.Limiter(2, 3600))
    admin = _user(db, "Admin", "admin")
    _as(monkeypatch, admin, reports)

    async def unreadable(*_a, **_k):
        return None
    monkeypatch.setattr(reports, "parse_intent", unreadable)
    with pytest.raises(HTTPException) as err:
        _run(reports.generate_from_prompt(_request(), reports.PromptBody(text="?")))
    assert err.value.status_code == 422
    with pytest.raises(HTTPException) as err:
        _run(reports.generate_from_prompt(_request(), reports.PromptBody(text="?")))
    assert err.value.status_code == 429


# ── Gate re-check: shared-proxy warning ────────────────────────────────

def test_railway_trusts_its_proxy_unless_told_not_to(monkeypatch):
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME", raising=False)
    monkeypatch.delenv("TRUST_PROXY_HEADERS", raising=False)
    monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
    assert rate_limit.trust_proxy_headers() is False
    assert rate_limit.proxy_warning() is None
    monkeypatch.setenv("RAILWAY_ENVIRONMENT", "production")
    assert rate_limit.trust_proxy_headers() is True  # blank on Railway = on
    assert rate_limit.proxy_warning() is None
    monkeypatch.setenv("TRUST_PROXY_HEADERS", "false")
    assert rate_limit.trust_proxy_headers() is False
    assert "TRUST_PROXY_HEADERS" in rate_limit.proxy_warning()
    monkeypatch.setenv("TRUST_PROXY_HEADERS", "true")
    assert rate_limit.proxy_warning() is None
