"""End-of-Day Daily-Breakdown prompt builder.

Returns the full instruction string for the LLM. The route handler is
responsible for shaping `summary_context` (today's data) and
`tomorrow_block_text` (pre-formatted schedule) — this module only owns the
*tone, structure and rules* of the message.
"""
from __future__ import annotations

from core.brand import BRITISH_ENGLISH, SELF_EMPLOYED_TERMS

# ─────────────────────────────────────────────────────────────────────────────
# House mantra + goal lines (kept here so they can be tweaked in one place)
# ─────────────────────────────────────────────────────────────────────────────
HOUSE_MANTRA = (
    "High standards\n"
    "High intensity\n"
    "Learn today, lead tomorrow 🌱"
)
HOUSE_GOALS = (
    "📈 Hit the weekly target\n"
    "📈 70%+ Welcome Calls completed\n"
    "📈 70%+ reaching their 3rd payment"
)

# ─────────────────────────────────────────────────────────────────────────────
# Tone references — verbatim sample messages the user shared. The LLM is
# instructed to match this tone but NOT to copy these BAs' names. Kept as
# raw strings so future edits stay readable.
# ─────────────────────────────────────────────────────────────────────────────
TONE_EXAMPLES = """\
EXAMPLE A:
Great work today, everyone.

🔔 Owen – 6
Consistency like this comes from discipline. Keeps showing up when it matters.

🛎️ Kai – 4
Growth mindset—asking for help and applying it.

Shoutout to everyone who pushed late. That's where legends are made.

Momentum is building. Leaders are stepping up, and the standard is rising. Stay locked in and finish the week the right way.

High standards.
High intensity.
Learn today, lead tomorrow.

📈 Hit the weekly target
📈 70%+ Welcome Calls completed
📈 70%+ reaching their 3rd payment

Who's ready to elevate and close strong? 🫡

EXAMPLE B:
Well done everyone – smashing it today! 🙌

🔔 Owen – 6 🔥 — Still hasn't missed; when challenged he'll always come out on top.
🛎️ Tess – 5 🌟 — Out here proving it's possible and not shy to ask for help.
🛎️ Theo – 3 💥 — Bouncing back, proving he's got this.
🛎️ Nina – 3 💫 — Pushing late and ringing that bell.
🎓 Maya – 1 🙂 — First sign-up earned and a late-night finish to prove herself.

Great work today 🙌 Bells are ringing 🛎️, leaders are leading 👨‍✈️, and the PACE is setting ‼️. Let's keep it rolling and finish this week strong ⚡🔥

High standards
High intensity
Learn today, lead tomorrow 🌱

📈 Hit the weekly target
📈 70%+ Welcome Calls completed
📈 70%+ reaching their 3rd payment

Who's stepping up to finish the week with a BANG?! 💥
"""

SYSTEM_MESSAGE = (
    "You write punchy, emoji-rich WhatsApp messages for the coaches and Owner "
    "of a door-to-door fundraising office. "
    "Keep it tight and scannable. " + BRITISH_ENGLISH + " " + SELF_EMPLOYED_TERMS
)


def build_daily_breakdown_prompt(
    summary_context: dict,
    tomorrow_block_text: str,
    custom_instructions: str = "",
) -> str:
    """Compose the full user-message prompt sent to the LLM.

    Args:
        summary_context: Dict with today's office data, week-to-date, last-week,
            rep_callouts, weekly_goal, etc. The handler already shaped this.
        tomorrow_block_text: Pre-formatted "📅 *Tomorrow — …*" block. The LLM is
            instructed to drop this in verbatim (no rewriting times/titles).
        custom_instructions: Free-form admin-authored overrides per office
            (tone, what to include, what to avoid, etc.). Injected at the top
            of the rules block so it can override the defaults below.
    """
    # Admin-authored custom block — if present, it goes right before the
    # baseline rules so the model treats it as the source of truth. Left
    # empty, the baseline rules apply untouched.
    custom_block = ""
    if (custom_instructions or "").strip():
        custom_block = (
            "═════════ ADMIN'S OWN INSTRUCTIONS (HIGHEST PRIORITY — follow "
            "these first; they OVERRIDE anything below if they conflict) "
            "═════════\n"
            f"{custom_instructions.strip()}\n"
            "════════════════════════════════════════════════════════════\n\n"
        )

    return (
        "You are writing an END-OF-DAY WhatsApp breakdown for a high-energy "
        "door-to-door fundraising office. The message is posted to a group with "
        "the entire network (coaches + Brand Ambassadors + new BAs). Match this house tone "
        "EXACTLY — energetic, masculine, growth-mindset, motivational without "
        "being cringey.\n\n"
        f"{custom_block}"
        "═════════ TONE REFERENCES ═════════\n"
        f"{TONE_EXAMPLES}"
        "═══════════════════════════════════\n\n"
        "STRUCTURE — follow this order strictly:\n"
        "1) ONE punchy opener line that names the day (e.g. 'Monday smashed 💪' "
        "or 'Great work today, everyone.')\n"
        "2) A blank line, then a per-BA callout block. Use:\n"
        "     🔔 = top performer of the day (most sign-ups)\n"
        "     🛎️ = anyone else who rang a bell today\n"
        "     🎓 = new BAs (use this if role == 'trainee')\n"
        "     🏃 = late grinder / volume hitter\n"
        "   Format: '🛎️ <Name> – <sign-ups> <vibe-emoji> — <one short line tied to their numbers>'\n"
        "   Pull the personalised line from the data: big delta vs same-day-"
        "last-week → 'bouncing back / setting the pace'; high share of £15+ "
        "sign-ups (`over30` in the data = Target £15 / Premium £20 monthly "
        "gifts) → 'quality sign-ups'; mostly £12 sign-ups (`under30` = "
        "Standard £12 gifts) → 'volume grinder / late-night legend'; new BA "
        "with first sign-up → 'getting on the board'. Ignore `memberships` — "
        "it is an unused legacy field; never mention memberships.\n"
        "   Skip anyone with 0 sign-ups today.\n"
        "3) ONE shoutout line to anyone who pushed late or grinded.\n"
        "4) A short 2-3 line momentum paragraph (coaches stepping up, standards "
        "rising, finish the week strong).\n"
        "5) The mantra block (each on its own line):\n"
        f"{HOUSE_MANTRA}\n"
        "6) The goal block (each on its own line):\n"
        f"{HOUSE_GOALS}\n"
        "7) ONE rallying close line ending in a question (e.g. \"Who's stepping "
        "up to finish the week with a BANG?! 💥\").\n"
        "8) A blank line, then INSERT THE TOMORROW'S SCHEDULE BLOCK BELOW "
        "VERBATIM — do NOT rewrite the times or titles, copy-paste it exactly.\n\n"
        "RULES:\n"
        "• Plain text + emojis only. NO markdown headers (no #, no **). Single "
        "asterisks *like this* are OK for WhatsApp bold.\n"
        "• ⚠️ ONLY use BA names that appear in the `rep_callouts` array of "
        "TODAY'S DATA below. NEVER use names from the EXAMPLE messages above "
        "(Owen / Tess / Kai / Theo / Nina / Maya) unless they are actually "
        "present in "
        "rep_callouts.\n"
        "• If `rep_callouts` is empty (nobody rang a bell today), SKIP the "
        "per-BA callout block entirely (steps 2-3) and write a short "
        "transition line like 'A grinder of a day — heads down, no bells, but "
        "the work compounds.' Then continue with the momentum paragraph + "
        "mantra + goals + close + tomorrow's schedule as normal.\n"
        "• Numbers must match the data exactly — do not invent sign-up counts.\n"
        "• Keep total length tight — under ~30 lines. Scannable.\n"
        "• Don't be cringey. No 'champions' / 'rockstars' / 'crushed it'. Match "
        "the reference tone.\n"
        "• Return ONLY the message text — no preamble, no JSON, no quotes "
        "around the output.\n"
        f"• {BRITISH_ENGLISH}\n"
        f"• {SELF_EMPLOYED_TERMS}\n\n"
        f"═════════ TODAY'S DATA ═════════\n{summary_context}\n\n"
        f"═════════ TOMORROW'S SCHEDULE BLOCK (insert verbatim at the end) "
        f"═════════\n{tomorrow_block_text}\n"
    )
