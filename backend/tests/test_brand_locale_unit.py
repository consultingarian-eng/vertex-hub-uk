"""Brand + UK locale guards for backend-rendered text.

  • The /launch page and every email carry APP_NAME / ORG_NAME and never the
    old US brand.
  • Dates written as text are UK style (uk_date, letters, absences).
  • Every AI prompt that writes prose people read asks for British English
    and carries the owner's self-employed terminology rule.
  • Backend-written text never uses employment language (everyone is
    self-employed): emails, and the letter maker's template fallback.
"""
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import brand  # noqa: E402
from core.app_time import APP_TZ_NAME, uk_date  # noqa: E402

OLD_BRAND = ("CG1", "Cube Group", "Cube Marketing")

# Employment words the owner's Latest Terminology Guide rules out. "self-employed"
# is the one allowed form of "employ".
EMPLOYMENT_WORDS = re.compile(
    r"(?<!self-)\bemploy\w*|\bhir(?:e|ed|es|ing)\b|new hire|\bjobs?\b|\bstaff\b|"
    r"\bsalar\w*|\bwages?\b|\bbonus\w*|\bmanager\b|\bboss\b|\bsupervis\w*|"
    r"\bpromot\w*|\btrainees?\b|\bpay ?slip",
    re.IGNORECASE,
)


def _no_employment_language(text: str):
    hit = EMPLOYMENT_WORDS.search(text)
    assert not hit, f"employment language {hit.group(0)!r} in: …{text[max(0, hit.start() - 60):hit.end() + 60]}…"


def _no_old_brand(text: str):
    for word in OLD_BRAND:
        assert word not in text, word


def test_defaults_are_vertex_and_uk():
    # Only the defaults are pinned — a deployment may override any of them.
    if not os.environ.get("APP_NAME"):
        assert brand.APP_NAME == "Vertex Hub"
    if not os.environ.get("ORG_NAME"):
        assert brand.ORG_NAME == "Vertex Organisation"
    if not os.environ.get("APP_TIMEZONE"):
        assert APP_TZ_NAME == "Europe/London"


def test_launch_page_is_branded():
    from routes import launch
    html = launch._HTML
    assert brand.APP_NAME in html and brand.ORG_NAME in html
    assert brand.FOREST in html and brand.LIME in html
    assert "/api/logo.png" in html
    _no_old_brand(html)


def test_every_email_is_branded(monkeypatch):
    from core import email_utils
    sent = []
    monkeypatch.setattr(email_utils, "send_email", lambda to, subject, html: sent.append((subject, html)))
    email_utils.send_admin_created_account_email("Sam", "sam@example.org", "pw", "trainee")
    email_utils.send_welcome_email("Sam", "sam@example.org")
    email_utils.send_promotion_email("Sam", "sam@example.org")
    email_utils.send_otp_email("Sam", "sam@example.org", "123456")
    email_utils.send_new_hire_email("Lee", "lee@example.org", "Sam", "sam@example.org")
    sent.append(("reset", email_utils.render_password_reset_email("654321")))
    assert len(sent) == 6
    for subject, html in sent:
        _no_old_brand(subject)
        _no_old_brand(html)
        _no_employment_language(subject)
        _no_employment_language(html)
        assert brand.ORG_NAME in html
        # the lime wordmark only ever sits on the forest header
        assert f"background: {brand.FOREST}" in html


def test_uk_date():
    assert uk_date("2026-09-30") == "30 Sep 2026"
    assert uk_date(date(2026, 10, 4), year=False) == "4 Oct"
    assert uk_date(datetime(2026, 1, 2, 23, 0)) == "2 Jan 2026"
    assert uk_date("not a date") == "not a date"


def test_absence_week_label_is_uk():
    from routes.absences import _week_label
    assert _week_label("2026-10-04") == "4 Oct"


def test_prose_prompts_ask_for_british_english():
    import report_builder
    from prompts import daily_breakdown_prompt
    from routes import coaching_assistant
    for prompt in (
        report_builder._SYSTEM,
        daily_breakdown_prompt.SYSTEM_MESSAGE,
        daily_breakdown_prompt.build_daily_breakdown_prompt({}, ""),
        coaching_assistant.SYSTEM_PROMPT,
    ):
        assert brand.BRITISH_ENGLISH in prompt
        assert brand.SELF_EMPLOYED_TERMS in prompt
        _no_old_brand(prompt)
        assert "American English" not in prompt
    assert "$30" not in daily_breakdown_prompt.build_daily_breakdown_prompt({}, "")


def test_self_employed_rule_names_the_key_mappings():
    rule = brand.SELF_EMPLOYED_TERMS
    assert "self-employed" in rule and "never use employment language" in rule
    for pair in ("not hire", "not job", "salary or wages", "incentives, not bonus",
                 "advancement, not promotion", "Initial Appointment, not interview",
                 "BA Fee Invoice, not pay slip", "Stage 3 (not Leader)", "coach"):
        assert pair in rule, pair
    assert brand.role_label("leader") == "Coach"
    assert brand.role_label("trainee") == "BA"
    assert brand.role_label("admin") == "Admin"


def test_every_prompt_that_asks_for_british_english_also_carries_the_terminology_rule():
    """Source-level guard: any module that appends BRITISH_ENGLISH to a prompt
    appends SELF_EMPLOYED_TERMS as well, so no AI-written text slips back into
    employment language (planner coach and quizzes build their
    prompts inline, so a text check on constants alone would miss them)."""
    users = []
    for path in BACKEND_DIR.rglob("*.py"):
        if "tests" in path.parts or "__pycache__" in path.parts or path.name == "brand.py":
            continue
        src = path.read_text(encoding="utf-8")
        if "BRITISH_ENGLISH" in src:
            users.append(path.name)
            # Every mention (the import and each prompt) is matched by one.
            assert src.count("SELF_EMPLOYED_TERMS") >= src.count("BRITISH_ENGLISH"), path
    assert len(users) >= 6, users
