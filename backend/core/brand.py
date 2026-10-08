"""Product and organisation names, plus the brand palette for backend-rendered
HTML (emails, the /launch page).

Every user-facing string that names the app or the company reads these —
never a hardcoded name — so a rename is one environment change. Internal
identifiers (collection names, the `cg1` in header names, module names) are
deliberately NOT branded.
"""
import os

APP_NAME = (os.environ.get("APP_NAME") or "").strip() or "Vertex Hub"
ORG_NAME = (os.environ.get("ORG_NAME") or "").strip() or "Vertex Organisation"

# Palette (mirrors the frontend theme). The logo is a lime wordmark on a
# transparent background, so it only ever sits on FOREST.
FOREST = "#102d25"
DEEP = "#0b211c"
MID = "#244c3b"
LIME = "#b7df58"        # accent — always dark text (INK/FOREST) on it
LIME_DARK = "#8caf38"
PAPER = "#f0f4e9"
CARD = "#f9faf4"
INK = "#17362b"
MUTED = "#50675a"
RULE = "#cedbc7"

# Appended to every AI prompt whose output people read (reports, coaching,
# planner coach, daily breakdown, conversation reviews, quizzes, letters).
BRITISH_ENGLISH = (
    "LANGUAGE: write everything people will read in British English — UK spelling "
    "and vocabulary (colour, behaviour, organise, programme, centre, favourite, "
    "cancelled; mobile not cell phone, postcode not zip code, holiday not vacation). "
    "Use £ for any money, UK-style dates (e.g. 30 Sep 2026 or 30/09/2026, never "
    "9/30) and 24-hour times (e.g. 15:10). Keep the team's own terms exactly as "
    "they are: Close, Rehash, Primetime, Bells, Sector, COD, BA. JSON keys "
    "and enum values stay exactly as specified."
)

# How each stored role value is SHOWN to people. The stored values
# (`trainee` / `leader` / `admin`) never change; only the words do. A leader
# coaches the BAs who report to them, so the role reads as "Coach".
ROLE_LABELS = {"trainee": "BA", "leader": "Coach", "admin": "Admin"}


def role_label(role: str | None) -> str:
    """Display word for a stored role value ('leader' -> 'Coach')."""
    key = (role or "trainee").strip().lower()
    return ROLE_LABELS.get(key, key.capitalize())


# The owner's "Latest Terminology Guide", appended next to BRITISH_ENGLISH on
# every AI prompt whose output people read. Everyone at the organisation is
# self-employed, so AI-written text must never use employment language.
SELF_EMPLOYED_TERMS = (
    "TERMINOLOGY: everyone here is self-employed — never use employment language. "
    "Say Brand Ambassador (BA) or the network, never staff, employee, worker or "
    "workforce. Say supporter, not customer; sign-up(s) for a count of sales. "
    "Recruit/appoint, not hire (new starter, not new hire); opportunity/career/role, "
    "not job or employment; earnings/fees/commission/performance-based pay, not "
    "salary or wages; incentives, not bonus; advancement, not promotion; "
    "guide/assist/coach, not manage, direct or supervise; coach or mentor, not "
    "manager or trainee manager; the Owner or the Marketing Director (the MD), not "
    "boss, employer or manager; terminate or release from contract, not fire or "
    "sack; responsibilities (as per trading agreement), not duties; long-term, not "
    "permanent; Initial Appointment, not interview; Business Presentation, not final "
    "interview; BA Fee Invoice, not pay slip; Earnings Day, not wages day; 'our day "
    "starts at', not 'have to start work at'; product coaching, not training "
    "provided. Ranks: Stage 3 (not Leader), Stage 4 (not crew manager), Stage 5 "
    "(not assistant manager). A BA's leader is their coach. Never write full time "
    "or part time."
)

FONT_HEADING ="'Fraunces', Georgia, 'Times New Roman', serif"
FONT_BODY = "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
GOOGLE_FONTS_HREF = (
    "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700"
    "&family=Inter:wght@400;500;600;700&display=swap"
)
