"""Email helpers via SendGrid + HTML email templates. Fails silently."""
import os
import re
import base64
import logging
from pathlib import Path

from core import brand as B

logger = logging.getLogger(__name__)

# ==================== EMAIL HELPER ====================

def get_app_base_url() -> str:
    """Public base URL of the deployed app (e.g. https://app.example.com),
    used for links and logo URLs in emails. Set APP_BASE_URL."""
    from core.app_config import app_base_url
    return app_base_url()


# Cache the logo bytes once per process — read on every send
_LOGO_CACHE: dict[str, bytes | None] = {}
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_LOGO_DIRS = (_BACKEND_DIR / "assets", _BACKEND_DIR / "static")


def _read_logo(name: str = "logo.png") -> bytes | None:
    """Read a logo file from backend/assets (or backend/static) and cache it."""
    if name in _LOGO_CACHE:
        return _LOGO_CACHE[name]
    data = None
    for d in _LOGO_DIRS:
        p = d / name
        try:
            if p.exists():
                data = p.read_bytes()
                break
        except Exception as e:
            logger.warning(f"Could not read {p}: {e}")
    _LOGO_CACHE[name] = data
    return data


def send_email(to_email: str, subject: str, html_content: str):
    """Send email via SendGrid with the company logo inlined as a CID attachment.

    Many email clients (Outlook iOS, ProtonMail, corporate Exchange, Apple Mail
    with Mail Privacy Protection) block remote images by default — that's why
    the logo was rendering as a broken `?` icon. Switching the <img src> to a
    `cid:` reference attached inline guarantees the logo always shows up.

    Fails silently with logging so callers don't have to worry about email
    being part of their critical path.
    """
    sg_key = os.environ.get("SENDGRID_API_KEY")
    from_email = (os.environ.get("SENDGRID_FROM_EMAIL") or "").strip()
    from_name = (os.environ.get("SENDGRID_FROM_NAME") or "").strip() or None
    if not sg_key or not from_email:
        logger.error(f"SENDGRID_API_KEY / SENDGRID_FROM_EMAIL not configured; skipping email to {to_email}: {subject}")
        return
    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import (
            Mail, From, Attachment, FileContent, FileName, FileType, Disposition, ContentId,
        )

        # ── Inline-attach any logo the template references ──────────────
        # Templates use `{base_url}/api/logo.png`. We rewrite it to a `cid:`
        # ref and attach the actual bytes as an inline attachment. This makes
        # the rendering resilient against image-blocking clients.
        attachments: list[Attachment] = []
        base = get_app_base_url()
        logo_specs = [
            ("logo.png", "logo"),
        ]
        for fname, cid in logo_specs:
            url_pattern = re.compile(rf"{re.escape(base)}/api/{re.escape(fname)}")
            if url_pattern.search(html_content):
                blob = _read_logo(fname)
                if blob:
                    html_content = url_pattern.sub(f"cid:{cid}", html_content)
                    att = Attachment(
                        FileContent(base64.b64encode(blob).decode("ascii")),
                        FileName(fname),
                        FileType("image/png"),
                        Disposition("inline"),
                        ContentId(cid),
                    )
                    attachments.append(att)

        message = Mail(from_email=From(from_email, from_name), to_emails=to_email, subject=subject, html_content=html_content)
        for att in attachments:
            message.attachment = att  # SendGrid's Mail accepts repeated assignment
        sg = SendGridAPIClient(sg_key)
        sg.send(message)
        logger.info(f"Email sent to {to_email}: {subject} (logos inlined: {len(attachments)})")
    except Exception as e:
        logger.error(f"SendGrid error sending to {to_email}: {e}")

# ==================== TEMPLATES ====================
# One shell for every email: the lime wordmark on a forest header (it has a
# transparent background, so it must never sit on white), Fraunces headings,
# Inter body, a paper/card body and a lime button with dark text.

_P = f"color: {B.INK}; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;"
_SMALL = f"color: {B.MUTED}; font-size: 13px; line-height: 1.5; margin: 0 0 8px 0;"
_LABEL = (f"color: {B.MID}; font-weight: 700; margin: 0 0 12px 0; font-size: 13px; "
          "letter-spacing: 0.4px; text-transform: uppercase;")
_BOX = (f"background: {B.PAPER}; border-radius: 12px; padding: 18px 20px; margin: 0 0 20px 0; "
        f"border-left: 4px solid {B.LIME_DARK};")
_ICON_TD = "padding: 6px 0; font-size: 15px; vertical-align: top; width: 24px;"
_TEXT_TD = f"padding: 6px 0 6px 10px; color: {B.INK}; font-size: 14px; line-height: 1.5;"


def _feature_rows(rows: list[tuple[str, str, str]]) -> str:
    return "".join(
        f'<tr><td style="{_ICON_TD}">{icon}</td><td style="{_TEXT_TD}"><strong>{title}</strong> — {text}</td></tr>'
        for icon, title, text in rows
    )


def _button(label: str, href: str) -> str:
    return (
        '<div style="text-align: center; margin: 0 0 22px 0;">'
        f'<a href="{href}" style="display: inline-block; background: {B.LIME}; color: {B.FOREST}; '
        'text-decoration: none; padding: 13px 28px; border-radius: 10px; font-weight: 700; '
        f'font-size: 15px; font-family: {B.FONT_BODY};">{label}</a></div>'
    )


def _code_box(label: str, code: str) -> str:
    return (
        f'<div style="background: {B.PAPER}; border: 1px solid {B.RULE}; border-radius: 12px; '
        'padding: 24px; text-align: center; margin: 0 0 20px 0;">'
        f'<p style="color: {B.MUTED}; font-size: 12px; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 1px;">{label}</p>'
        f'<p style="font-family: {B.FONT_HEADING}; color: {B.FOREST}; font-size: 40px; letter-spacing: 10px; margin: 0; font-weight: 700;">{code}</p>'
        '</div>'
    )


def render_email(heading: str, subheading: str, body_html: str) -> str:
    """Wrap body HTML in the branded email shell (header, card, footer)."""
    logo_url = f"{get_app_base_url()}/api/logo.png"
    sub = (f'<p style="color: {B.LIME}; margin: 8px 0 0 0; font-size: 14px; font-family: {B.FONT_BODY};">{subheading}</p>'
           if subheading else "")
    return f"""
    <link href="{B.GOOGLE_FONTS_HREF}" rel="stylesheet">
    <div style="font-family: {B.FONT_BODY}; max-width: 520px; margin: 0 auto; padding: 32px 16px; background: {B.PAPER};">
        <div style="background: {B.FOREST}; border-radius: 16px 16px 0 0; padding: 32px 24px; text-align: center;">
            <img src="{logo_url}" alt="{B.APP_NAME}" width="180" height="60" style="display: block; margin: 0 auto 18px auto; width: 180px; height: auto; border: 0;" />
            <h1 style="font-family: {B.FONT_HEADING}; color: {B.PAPER}; margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.2px;">{heading}</h1>
            {sub}
        </div>
        <div style="background: {B.CARD}; padding: 32px 24px; border-radius: 0 0 16px 16px; border: 1px solid {B.RULE}; border-top: none;">
            {body_html}
            <hr style="border: none; border-top: 1px solid {B.RULE}; margin: 24px 0;" />
            <p style="color: {B.MUTED}; font-size: 11px; margin: 0; text-align: center;">{B.ORG_NAME} · {B.APP_NAME}</p>
        </div>
    </div>
    """


def send_admin_created_account_email(name: str, email: str, password: str, role: str):
    """Welcome email for users created directly by an admin.

    Same look as the standard welcome email, but bundles the assigned login
    credentials so the new starter can sign in without going through OTP.
    """
    app_url = get_app_base_url() or "/"
    role_label = B.role_label(role)
    button = _button(f"Open {B.APP_NAME}", app_url)
    features = _feature_rows([
        ("📋", "Manual", "your 8-day guide"),
        ("🧠", "Campaign Knowledge", "lessons, quizzes and the exam"),
        ("📊", "My Progress", "your journey and scores"),
        ("🏆", "Achievements", "badges for real milestones"),
    ])
    body = f"""
            <p style="{_P}">Hi <strong>{name}</strong>,</p>
            <p style="{_P}">Your <strong>{role_label}</strong> account on {B.APP_NAME} has been set up by your admin. Use the details below to sign in.</p>
            <div style="{_BOX}">
                <p style="{_LABEL}">Your login</p>
                <p style="margin: 0 0 4px 0; color: {B.INK}; font-size: 14px;"><strong>Email:</strong> <span style="color: {B.MID}; font-family: monospace;">{email}</span></p>
                <p style="margin: 0 0 4px 0; color: {B.INK}; font-size: 14px;"><strong>Password:</strong> <span style="color: {B.MID}; font-family: monospace;">{password}</span></p>
                <p style="margin: 12px 0 0 0; color: {B.MUTED}; font-size: 12px;">Tip: change your password from the Profile tab after you first sign in.</p>
            </div>
            {button}
            <div style="{_BOX}">
                <p style="{_LABEL}">What's inside</p>
                <table style="width: 100%; border-collapse: collapse;">{features}</table>
            </div>
            <p style="{_P} margin: 0;">Your coach will guide you through your daily assessments and field coaching. Add {B.APP_NAME} to your phone's home screen so you get notifications for your schedule and updates.</p>
    """
    send_email(email, f"Your {B.APP_NAME} account is ready",
               render_email(f"Welcome to {B.APP_NAME}", "Your account has been created", body))


def send_welcome_email(name: str, email: str):
    app_url = get_app_base_url() or "/"
    button = _button(f"Open {B.APP_NAME}", app_url)
    features = _feature_rows([
        ("📋", "Manual", "your full 8-day guide, and what good looks like on every skill"),
        ("🧠", "Campaign Knowledge", "bite-size lessons and quizzes, then the certification exam"),
        ("📊", "My Progress", "your day-by-day journey and every assessment score"),
        ("🏆", "Achievements", "earn real badges for first sign-ups, milestones and more"),
        ("🗓️", "Office Schedule", "every day's plan, with reminders sent to your phone"),
        ("💷", "Earnings Calculator", "forecast your earnings"),
    ])
    body = f"""
            <p style="{_P}">Hi <strong>{name}</strong>,</p>
            <p style="{_P}">Welcome to the network! Your {B.APP_NAME} account is live. Over your first 8 days — 2 BA Academy days plus 6 in the field — your coach will guide you through the coaching that turns doors into sign-ups.</p>
            <div style="{_BOX}">
                <p style="{_LABEL}">What you can do in the app</p>
                <table style="width: 100%; border-collapse: collapse;">{features}</table>
            </div>
            {button}
            <p style="{_P}">Your coach will be assigned shortly — they'll run your daily assessments and coach you through your field days.</p>
            <p style="{_P} margin: 0;">Let's get started — sign in and have a look at your Manual!</p>
    """
    send_email(email, f"Welcome to {B.APP_NAME} — your first 8 days start now!",
               render_email(f"Welcome to {B.APP_NAME}", f"{B.ORG_NAME} · BA Academy", body))


def send_promotion_email(name: str, email: str):
    app_url = get_app_base_url() or "/"
    button = _button(f"Open {B.APP_NAME}", app_url)
    features = _feature_rows([
        ("👥", "My Team", "org chart, daily assessments, delivery checklists and progress tracking for every new BA you coach"),
        ("✅", "Today's Grading", "Home now shows every ungraded new-BA day up front, oldest first, so nothing slips"),
        ("🎯", "Monthly Goal Planner", "set monthly goals, budget, SWOT and team gap analysis, with reminders in the last 3 days of every month"),
        ("🔔", "Bells", "a live sign-up sheet for your team and the whole office, with daily and weekly stats, scoring and rankings"),
        ("🪪", "ID Badges", "generate branded ID cards with QR codes for your new BAs in seconds"),
        ("⭐", "Coaches-only Schedule Blocks", "coach-only meetings now show up on your schedule"),
        ("➕", "Add New Starters", "bring new BAs onto the platform and into your team"),
    ])
    body = f"""
            <p style="{_P}">Hi <strong>{name}</strong>,</p>
            <p style="{_P}">Your hard work has been recognised! You've advanced to <strong>Stage 3</strong> and you're now a <strong>Coach</strong> in {B.APP_NAME}. Your own first-8-days record is now marked complete — no ungraded days will follow you into leadership. You now have new tools to guide and develop your team.</p>
            <div style="{_BOX}">
                <p style="{_LABEL}">Your new coach features</p>
                <table style="width: 100%; border-collapse: collapse;">{features}</table>
            </div>
            <div style="{_BOX}">
                <p style="{_LABEL}">🏆 New badges to chase as a coach</p>
                <p style="color: {B.INK}; font-size: 14px; line-height: 1.5; margin: 0;">🤝 <strong>Team Builder</strong> the moment your first new BA is assigned to you, and 👑 <strong>Core Coach</strong> the day someone on your team advances to Stage 3 too. Check My Badges on your profile.</p>
            </div>
            {button}
            <p style="{_P}">Sign in and you'll notice your navigation has changed — Home now leads with your team's pulse and your grading queue.</p>
            <p style="{_P} margin: 0;">Welcome to leadership. Your team is counting on you! 💪</p>
    """
    send_email(email, "Congratulations on your advancement to Stage 3! 🎉",
               render_email("🎉 Congratulations!", "You've advanced to <strong>Stage 3</strong>", body))


def send_otp_email(name: str, email: str, code: str):
    display_name = (name or "there").strip() or "there"
    code_box = _code_box("Your code", code)
    body = f"""
            <p style="{_P}">Hi <strong>{display_name}</strong>,</p>
            <p style="{_P}">Enter this code in {B.APP_NAME} to finish creating your account:</p>
            {code_box}
            <p style="{_SMALL}">This code expires in <strong>10 minutes</strong>.</p>
            <p style="{_SMALL} margin: 0;">If you didn't sign up for {B.APP_NAME}, you can safely ignore this email.</p>
    """
    send_email(email, f"Your {B.APP_NAME} verification code: {code}",
               render_email("Verify your email", f"{B.ORG_NAME} · {B.APP_NAME}", body))


def send_new_hire_email(leader_name: str, leader_email: str, hire_name: str, hire_email: str):
    step = f"padding: 6px 0; color: {B.INK}; font-size: 14px; vertical-align: top;"
    body = f"""
            <p style="{_P}">Hi <strong>{leader_name}</strong>,</p>
            <p style="{_P}"><strong>{hire_name}</strong> has joined your team as a new BA — you're their coach in {B.APP_NAME}.</p>
            <div style="{_BOX}">
                <p style="{_LABEL}">📋 What to do next</p>
                <table style="width: 100%; border-collapse: collapse;">
                    <tr><td style="{step}">1.</td><td style="{step} padding-left: 8px;">Open the <strong>My Team</strong> tab to see {hire_name} in your org chart</td></tr>
                    <tr><td style="{step}">2.</td><td style="{step} padding-left: 8px;">Go through <strong>Day 1 of the Manual</strong> with them</td></tr>
                    <tr><td style="{step}">3.</td><td style="{step} padding-left: 8px;">Fill in their <strong>Daily Assessment</strong> at the end of the day</td></tr>
                </table>
            </div>
            <p style="{_P} margin: 0;">Sign in to the app and head to your team dashboard to get started. Let's build another winner! 🚀</p>
    """
    send_email(leader_email, f"New starter added to your team: {hire_name}",
               render_email("👥 New team member", "A new BA has joined your team", body))


def render_password_reset_email(code: str) -> str:
    """HTML for the password-reset code email (sent by routes/auth_routes.py,
    which reports send failures to the user instead of failing silently)."""
    code_box = _code_box("Your reset code", code)
    body = f"""
            <p style="{_P}">You asked to reset the password for your {B.APP_NAME} account.</p>
            {code_box}
            <p style="{_SMALL} margin: 0;">This code expires in 15 minutes. If you didn't ask for this, you can ignore this email.</p>
    """
    return render_email("Password reset", f"{B.ORG_NAME} · {B.APP_NAME}", body)
