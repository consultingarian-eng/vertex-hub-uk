"""Seed data for the multi-stage Training Modules system.

Stage 2 topics are sourced verbatim from the latest Stage 2 COD sheet
(21 topics across 7 categories). Stage 3 topics are from the user's JSON
spec + Americanized UK Leadership Toolkit content.

Stage 1 COD capabilities derive from the Final Cycle of Development doc's
Foundation page (the 4-Pillar tick-box sheet) — they do NOT mirror the
Day 1-8 `training_manual` assessments, which remain the trainee's daily
grading flow, unchanged.

Wording note (Sep 2026): seeded copies get the plain-English rewrite from
seed/cod_content_simplified.json via _apply_simplified_overlay() — the
raw curriculum text below is the historical source, kept verbatim.
"""
import logging

logger = logging.getLogger(__name__)

ASSESSMENT_BANDS = [
    {"min": 1, "max": 3, "label": "Learning"},
    {"min": 4, "max": 6, "label": "Developing"},
    {"min": 7, "max": 8, "label": "Competent"},
    {"min": 9, "max": 10, "label": "Independent"},
]

ASSESSMENT_DIMENSIONS = ["knowledge", "skill", "consistency", "independence"]

# COD 2026 Proof Ladder — the grader. Every capability climbs these rungs;
# a capability counts as met at Deliver, and keeps climbing through Teach
# and Systemize. Self-learners may claim Know and Do; Deliver and above are
# signed off by the coach (upline leader/admin) — the in-app equivalent of
# the printed sheet's COACH SIGN-OFF box.
LADDER_RUNGS = [
    {"value": 1, "key": "know", "label": "Know", "blurb": "Can explain it simply", "self": True},
    {"value": 2, "key": "do", "label": "Do", "blurb": "Can execute it effectively in the office", "self": True},
    {"value": 3, "key": "deliver", "label": "Deliver", "blurb": "Hits the standard under pressure in the field", "self": False},
    {"value": 4, "key": "teach", "label": "Teach", "blurb": "Can transfer it to others", "self": False},
    {"value": 5, "key": "systemize", "label": "Systemize", "blurb": "Runs as a system — independent examples of WGLL", "self": False},
]
LADDER_COMPLETED_AT = 3  # Deliver


def _module(category: str, topic: str, content: str, good: list, measured: list,
            coach: list, prompts: dict | None = None) -> dict:
    """Helper that fills in standard 4-dimension prompts when not provided."""
    default_prompts = {
        "knowledge": f"Can clearly explain {topic.lower()}",
        "skill": f"Can demonstrate {topic.lower()} in the field or roleplay",
        "consistency": f"Applies {topic.lower()} reliably across multiple days",
        "independence": f"Uses {topic.lower()} without coach prompting",
    }
    return {
        "stage": 2,
        "category": category,
        "topic": topic,
        "trainee_content": content,
        "what_good_looks_like": good,
        "how_measured": measured,
        "leader_coaching_notes": coach,
        "assessment_prompts": prompts or default_prompts,
    }


def _s1(category: str, topic: str, content: str, good: list, measured: list,
        coach: list, prompts: dict | None = None) -> dict:
    """Stage 1 (Foundation) helper — same schema as _module(), foundation-level
    default prompts (no teach/systemize language at this stage)."""
    default_prompts = {
        "knowledge": f"Can explain {topic.lower()} simply and why it matters",
        "skill": f"Can demonstrate {topic.lower()} in roleplay and in a live environment",
        "consistency": f"Shows {topic.lower()} reliably across consecutive days",
        "independence": f"Applies {topic.lower()} without being prompted",
    }
    return {
        "stage": 1,
        "category": category,
        "topic": topic,
        "trainee_content": content,
        "what_good_looks_like": good,
        "how_measured": measured,
        "leader_coaching_notes": coach,
        "assessment_prompts": prompts or default_prompts,
    }


# ──────────────────────────────────────────────────────────────────────────
# STAGE 1  ·  FOUNDATION — Build Your Core Competencies
# COD 2026 (Final Cycle of Development, Aug 2026). The Foundation
# sheet's capabilities grouped by the 4 Pillars; content derives from the
# document's What Good Looks Like page — NOT from the Day 1-8 assessments.
# ──────────────────────────────────────────────────────────────────────────

STAGE_1_MODULES = [
    # ── The Standard ───────────────────────────────────────────────────────
    _s1("The Standard", "Stage 1 — The Foundation Standard",
        "Stage 1 is the foundation everything else is built on: the core competencies of the role, learned "
        "properly and proven, not just attended. You work the material daily, prove it in roleplay and in a live "
        "environment, and your coach signs the proof. Progression is evidence-based, never time-served.",
        ["Evidence: three consecutive days with great time ownership and effort",
         "Evidence: can demonstrate the 5-step sign-up process and handle common objections in office roleplay AND in a live environment",
         "Evidence: Field IQ completed with no missing fields"],
        ["Non-negotiables: attendance, professionalism, honesty, data submission",
         "A missed standard means immediate coaching and a same-day retrain plan",
         "Repeated misses pause progression"],
        ["Agree the evidence up front — the three items above are the sign-off",
         "Tools to be used daily: Learning Library, Field IQ",
         "Coach on the standard the day it slips, never the week after"]),

    # ── Commercial Craft ───────────────────────────────────────────────────
    _s1("Commercial Craft", "5-Step Sign-Up Process",
        "The 5 Steps are the spine of every conversation: Introduction, Present the Problem, The Solution, The "
        "Close, Rehash. You run the full sign-up process in the correct order without missing any steps — and it sounds confident and conversational, never rehearsed. The order exists "
        "because each step earns the next one; skipping a step is why closes fall flat.",
        ["Runs the full sign-up process in the correct order without missing any steps",
         "Sounds confident and conversational, not rehearsed",
         "Each step earns the next — no jumping to the close"],
        ["Office roleplay: all five steps, in order, unprompted",
         "Field observation on a live pitch",
         "Can name which step a stalled conversation is stuck on"],
        ["Drill the order until it's automatic, then coach the delivery",
         "If it sounds scripted, roleplay with interruptions until it flexes",
         "Debrief live pitches step by step — where was the miss?"]),
    _s1("Commercial Craft", "SEE Principle",
        "SEE — Smile, Eye contact, Enthusiasm — creates immediate connection. The person at the door can hear the smile in "
        "your voice; your eye contact shows you are present and trustworthy; your enthusiasm shows you genuinely "
        "believe in what you're talking about. Connection is built in the first seconds, before your words matter.",
        ["Creates immediate connection in the first seconds",
         "The person at the door can hear the smile in your voice",
         "Eye contact shows you are present and trustworthy",
         "Enthusiasm shows genuine belief in what you're talking about"],
        ["Field observation of first impressions across several approaches",
         "Roleplay: can they switch SEE on after a rejection?",
         "Stop-rate holding steady through the day"],
        ["Coach it physically — smile, posture, energy — not as theory",
         "Watch the approach after a hard no: SEE is proven under rejection",
         "Film a roleplay and let them see their own first three seconds"]),
    _s1("Commercial Craft", "Clear Close",
        "Interest is not a result — commitment is. You close the sign-up clearly and confidently, turning the "
        "supporter's interest into a clear commitment. No trailing off, no hoping they volunteer; you ask, "
        "cleanly, and you're comfortable in the silence that follows. Close with clarity: direct, slow, warm, "
        "long term — then tell them what happens next.",
        ["Closes clearly and confidently — turns interest into a clear commitment",
         "Asks for the sign-up directly instead of waiting to be offered it",
         "Comfortable with silence after the ask"],
        ["Roleplay: the close is asked, not implied",
         "Field observation: conversion of interested conversations",
         "Sign-ups where the supporter knew exactly what they agreed to"],
        ["Most new starters talk past the close — coach the stop",
         "Drill three clean closing lines until one feels natural",
         "Debrief 'almosts': was the close actually asked?"]),
    _s1("Commercial Craft", "Question Handling",
        "Questions are interest wearing a disguise. You handle common questions and campaign-specific objections "
        "by listening, using the systems, understanding the real concern underneath, and checking it's resolved "
        "before re-closing — Feel, Relate, Felt, Found, Re-close. Answering the wrong question loses the sign-up "
        "even when the answer is right.",
        ["Listens first — finds the real concern under the stated question",
         "Uses the systems rather than improvising answers",
         "Checks the concern is resolved before re-closing"],
        ["Roleplay the concerns we can address: other charities, one-off, bank details, online, more information",
         "Field observation: composure and structure when questioned",
         "Re-close rate after a handled question"],
        ["Teach the pattern: listen → answer → check → re-close",
         "Drill Feel, Relate, Felt, Found, Re-close on each concern we can address",
         "Coach listening — most BAs answer the wrong question"]),
    _s1("Commercial Craft", "Impulses",
        "The impulses are why people act now rather than later — G.I.F.T.S: Generosity, Indifference, Feel Good "
        "Factor, Tone of Voice / Body Language, Support. You can articulate each impulse and use it "
        "naturally throughout the conversation — and you know where and how each one should be used. Used "
        "naturally they create momentum; forced, they create pressure.",
        ["Can articulate the impulses and what each one does",
         "Uses them naturally throughout the conversation, not bolted on",
         "Knows where and how each impulse should be used"],
        ["Verbal check: name the impulses and where each belongs",
         "Roleplay: impulses woven in without sounding forced",
         "Field observation of momentum in live conversations"],
        ["Have them spot the impulses in YOUR pitch first",
         "Coach one impulse at a time into their conversation",
         "Correct anything that drifts towards pressure immediately"]),
    _s1("Commercial Craft", "Accurate Body Positioning",
        "Your body pitches before your mouth does. You stand in the right place, use open, confident, engaging "
        "posture, and use hand movements and gestures to build trust and show enthusiasm — while always "
        "respecting personal space. Positioning decides whether the conversation even starts.",
        ["Stands in the right place to open the conversation naturally",
         "Open, confident, engaging posture — hands and gestures build trust",
         "Respects personal space at all times"],
        ["Field observation of positioning across the day",
         "Roleplay: approach angle, stance, and distance",
         "Stop-rate as evidence the positioning works"],
        ["Walk the patch and physically place them — this is coached by doing",
         "Mirror their stance back to them; posture is invisible to its owner",
         "Watch distance: trust dies at both too-far and too-close"]),

    # ── Self Leadership ────────────────────────────────────────────────────
    _s1("Self Leadership", "Professional Reliability",
        "Reliability is the first professional skill: respecting start times and schedules, arriving prepared and "
        "ready to work. You can be relied upon to manage yourself without needing reminders or follow-up — "
        "nobody chases you, because nothing about you needs chasing.",
        ["Respects start times and schedules — prepared and ready to work",
         "Manages themselves without reminders or follow-up",
         "The team can count on them every day, not most days"],
        ["Punctuality and readiness across consecutive days",
         "Zero chase-ups needed over a full week",
         "Shows up equally on good days and bad days"],
        ["Set the expectation once, clearly — then hold it every time",
         "Praise reliability out loud; it's the habit everything builds on",
         "One slip: coach same day. Pattern: retrain plan"]),
    _s1("Self Leadership", "Resilience After Rejection",
        "Rejection is the weather on the doors — it isn't about you. You don't let one bad interaction affect the next "
        "one: you respond to rejection quickly and reset for the next opportunity, staying productive instead of "
        "becoming emotional or discouraged. You can separate outcomes from your attitude and effort.",
        ["Doesn't let one bad interaction affect the next one",
         "Responds to rejection quickly and resets for the next opportunity",
         "Stays productive instead of becoming emotional or discouraged",
         "Separates outcomes from attitude and effort"],
        ["Field observation: the pitch AFTER a hard no",
         "Activity level holding through a slow morning",
         "Self-talk when debriefing a rough session"],
        ["Watch the recovery, not the rejection — that's where the coaching is",
         "Teach the reset ritual: breathe, next door, fresh start",
         "Normalise the numbers: rejection is the cost of every yes"]),
    _s1("Self Leadership", "Emotional Regulation in the Field",
        "Consistency is a choice you make before the day tests you. You demonstrate emotional resilience and "
        "remain consistent even when faced with challenges — and you can separate personal circumstances from "
        "professional performance. The field never knows what kind of morning you had.",
        ["Remains consistent even when faced with challenges",
         "Separates personal circumstances from professional performance",
         "Steady presence — teammates can't read the bad day off them"],
        ["Observation across high days and low days",
         "Composure in front of supporters when things go wrong",
         "Consistency of effort regardless of results"],
        ["Coach the pattern, never the single bad moment",
         "Model it yourself — regulation is caught as much as taught",
         "Give a private reset route for genuinely hard days"]),

    # ── People Leadership ──────────────────────────────────────────────────
    _s1("People Leadership", "Follows Standards",
        "Standards are what you do when nobody's watching. You demonstrate discipline and effort without needing "
        "supervision or recognition, and you know what good looks like for quality standards and KPIs. Following "
        "standards as a BA is the first rep of enforcing them at Stage 3.",
        ["Demonstrates discipline and effort without supervision or recognition",
         "Knows WGLL for quality standards and KPIs",
         "Same standard whether the coach is present or not"],
        ["Unannounced observation vs. accompanied observation — same person?",
         "Quality KPIs holding without prompting",
         "Verbal check: can they state the standards from memory?"],
        ["Make the standards explicit early — vague standards can't be followed",
         "Catch them meeting the standard unseen and say so",
         "Connect today's discipline to tomorrow's leadership"]),
    _s1("People Leadership", "Communicates Clearly",
        "Clear communication is a performance skill. You keep updates clear, and you raise issues appropriately "
        "and professionally — the right person, the right time, the right tone. A team runs on information; "
        "yours can be trusted and acted on.",
        ["Keeps updates clear — short, accurate, on time",
         "Raises issues appropriately and professionally",
         "Right person, right time, right tone"],
        ["Quality of daily check-ins and end-of-day updates",
         "How the last issue they raised was raised",
         "Zero surprises: problems surface from them first"],
        ["Give the update format once — what, numbers, blockers",
         "Praise a well-raised issue publicly; it teaches the whole team",
         "Coach tone separately from content — both matter"]),
    _s1("People Leadership", "Seeks Support Early & Proactively",
        "Struggling silently is the expensive option. You flag challenges, ask questions, and use support "
        "correctly so problems can be solved quickly — while they're still small. Asking early is a strength "
        "signal at every level of this business.",
        ["Flags challenges early, while they're still small",
         "Asks questions instead of guessing",
         "Uses support correctly so problems get solved quickly"],
        ["Time between a problem appearing and them raising it",
         "Questions asked in coaching — silence is the warning sign",
         "Problems solved at the cheap stage vs. the expensive stage"],
        ["React well to the first flag — that decides if there's a second",
         "Ask 'what are you stuck on?' daily until they volunteer it",
         "Tell the story of a problem that got expensive by hiding"]),

    # ── Digital & Data ─────────────────────────────────────────────────────
    _s1("Digital & Data", "Field IQ",
        "Field IQ is the office's single source of truth, and it's only true if you feed it. You make Field IQ "
        "part of your daily routine — complete, accurate, no missing fields, every day. Your numbers drive "
        "your coaching, your territory decisions, and your earnings; gaps in the data are gaps in all three.",
        ["Makes Field IQ part of the daily routine",
         "Complete and accurate — no missing fields",
         "Submitted every day without being chased"],
        ["Field IQ completed with no missing fields (Stage 1 evidence item)",
         "Zero data chase-ups over a full week",
         "Spot-check: does the data match the day?"],
        ["Do the first submissions together until the habit sets",
         "Show them THEIR data being used in a coaching decision",
         "Honesty in data is a non-negotiable — hold it absolutely"]),
    _s1("Digital & Data", "Law of Averages",
        "The law of averages is not an excuse to be average. It is a reminder to control the inputs. "
        "The Law of Averages is why effort works: consistent inputs produce predictable outputs. You understand "
        "and apply LOA to drive consistent results — you know your numbers, you trust the ratios, and you keep "
        "feeding the top of the funnel on slow days instead of doubting the process.",
        ["Understands LOA and can explain it simply",
         "Applies it to drive consistent results — inputs stay up on slow days",
         "Trusts the ratios instead of riding the emotional rollercoaster"],
        ["Verbal check: explain LOA and their own current ratios",
         "Activity holding steady through a low-conversion day",
         "Uses LOA language when debriefing results"],
        ["Work out their personal ratios together from real data",
         "On a slow day, coach back to inputs — LOA is the antidote to panic",
         "Show the weekly view: the average always tells a calmer story"]),
    _s1("Digital & Data", "Quality KPIs",
        "Volume without quality is borrowed money. You can articulate the quality KPIs and why achieving them "
        "matters — and you show the actions that maintain high-quality sign-ups: right expectations set, right "
        "details captured, right supporter signed for the right reasons. The quality KPIs: 70%+ Welcome Calls "
        "answered, 1st payment 85%+, 3rd payment 70%+.",
        ["Can articulate the quality KPIs and why they matter",
         "Shows the actions that maintain high-quality sign-ups",
         "Sets right expectations so sign-ups stick"],
        ["Verbal check: name the quality KPIs and the behaviours behind them",
         "Their own quality numbers over recent weeks",
         "Observation: expectations set correctly at the close"],
        ["Tie quality to their own earnings — it's not abstract",
         "Review one of their sign-ups together against the quality checklist",
         "Coach the behaviour behind a quality dip, not the number itself"]),
]

# ──────────────────────────────────────────────────────────────────────────
# STAGE 2  ·  SELF MANAGEMENT — Operate Like a Professional
# COD 2026 (Final Cycle of Development, Aug 2026). Capabilities grouped
# by the 4 Pillars; content derives from the document's What Good Looks Like.
# ──────────────────────────────────────────────────────────────────────────

STAGE_2_MODULES = [
    # ── The Standard ───────────────────────────────────────────────────────
    _module("The Standard", "Stage 2 — The Self Management Standard",
        "Stage 2 is where you stop being coached through every day and start operating like a professional: your "
        "plan, your numbers, your standards — owned by you. Progression is evidence-based, never time-served. "
        "Everything from Stage 1 still applies; Stage 2 builds on it.",
        ["Evidence: a weekly plan with one education goal and one financial goal made for next week",
         "Evidence: can explain personal breakeven and demonstrates behaviours that support it",
         "Evidence: communicates their personal goals and vision",
         "Evidence: shows an improvement trend in at least one key KPI over 1-2 weeks"],
        ["Continue maintaining and building on every COD 1 standard",
         "A missed target over a full week triggers a written coaching plan within 24 hours"],
        ["Review the four evidence items in the weekly rhythm — agree the proof up front",
         "Tools to be used daily: Weekly Planning Template, Learning Library, Quality Checklist",
         "If COD 1 standards slip, fix those before progressing anything here"]),

    # ── Commercial Craft ───────────────────────────────────────────────────
    _module("Commercial Craft", "Improved Question Handling",
        "Stage 2 question handling means clarity and structure no matter the conditions — rain, noise, a sceptical "
        "householder, a long day. You listen for the real concern under the question, answer it using the system, check "
        "it's resolved, and re-close. No freezing, no winging it, no letting one hard question derail the pitch.",
        ["Handles questions with clarity and structure regardless of external conditions or influences",
         "Finds the real concern underneath the stated question",
         "Checks the concern is resolved before re-closing"],
        ["Roleplay with curveball questions under pressure",
         "Field observation across different conditions",
         "Conversion holding steady on hard-question days"],
        ["Throw the ugliest questions in roleplay — structure should survive",
         "Coach listening first: most BAs answer the wrong question",
         "Watch a rainy-day pitch — conditions reveal structure"]),
    _module("Commercial Craft", "Close Variations",
        "One script is a ceiling. You can use close variations confidently rather than relying on one script — "
        "reading the person and adapting in real time. Different people commit for different reasons; your close "
        "should meet the person in front of you.",
        ["Uses close variations confidently, not one memorised script",
         "Reads the person and adapts in real time",
         "Switches angles mid-conversation when the first close doesn't land"],
        ["Roleplay: same pitch, three different supporter types",
         "Field observation of close selection",
         "Close rate across supporter demographics"],
        ["Name the closes together — a shared vocabulary makes coaching specific",
         "Debrief real doors: which close, why, what else would have worked?",
         "Drill the switch: first close misses, what now?"]),
    _module("Commercial Craft", "Territory Awareness & Adaptability",
        "You understand the variances — footfall, demographics, cultural background, rapport, age groups — and "
        "adjust your approach accordingly. The same pitch doesn't work on every street; Stage 2 means you read the "
        "territory and flex without being told to.",
        ["Understands footfall, demographic, and cultural variances in a territory",
         "Adjusts approach to the area without being prompted",
         "Performance holds across different territory types"],
        ["Results compared across contrasting patches",
         "Can explain how today's territory changes the approach",
         "Coach observation of in-field adaptation"],
        ["Quiz them on the patch before knocking starts: who lives here, what lands?",
         "Compare their numbers across area types and coach the gap",
         "Rotate them deliberately through contrasting territories"]),
    _module("Commercial Craft", "Rehash & Consolidation",
        "The sign-up isn't finished when they say yes. You reinforce impact and value clearly, confirm full "
        "understanding — what they agreed to, amounts, frequency, dates — and leave the supporter feeling good about "
        "the decision — the Pop Quiz (monthly amount, frequency, start date: 1st / 8th / 15th / 22nd, why NDCS makes a "
        "Welcome Call) and the 3 Thank You's. Consolidation is where quality is made: a confident supporter stays, "
        "a confused one cancels.",
        ["Reinforces impact and value clearly after the yes",
         "Confirms full understanding: what they agreed to, amounts, frequency, dates",
         "Leaves the supporter feeling good about their decision"],
        ["Quality KPIs: donations stick, cancellations low",
         "Observed consolidations cover every confirmation point",
         "Supporter callbacks and confusion complaints at zero"],
        ["Watch the 60 seconds AFTER the yes — that's the module",
         "Tie their cancellation numbers to consolidation habits",
         "Roleplay the confirmation checklist until it's automatic"]),

    # ── Self Leadership ────────────────────────────────────────────────────
    _module("Self Leadership", "Personal Planning",
        "You have a clear weekly plan and review it without being prompted — and the plan is built on data, not "
        "feelings. What you'll hit, which days, what you're improving, what it pays: written down before the week "
        "starts, checked as the week runs.",
        ["Has a clear weekly plan and reviews it without prompting",
         "Builds the plan from data, not feelings",
         "Plan includes one education goal and one financial goal"],
        ["Weekly plan exists before Monday, on record",
         "Mid-week self-review happens unprompted",
         "Plan accuracy improves week over week"],
        ["Review their plan every Monday for a month, then spot-check",
         "Ask what data drove each target — 'it felt right' isn't a source",
         "Coach the review habit: a plan nobody rechecks is a wish"]),
    _module("Self Leadership", "Student Mentality",
        "You actively seek out feedback and coaching rather than waiting for it — and you apply it without needing "
        "to be told twice. The fastest-advancing people in this business are the best students: they ask, they listen, "
        "they change the behaviour the same day, and they come back for more.",
        ["Actively seeks out feedback and coaching rather than waiting for it",
         "Applies a correction the same day, visibly",
         "Never needs the same coaching twice"],
        ["Coaching applied on first delivery — coach confirms",
         "Feedback requests initiated by the BA, on record",
         "Skill trajectory week over week"],
        ["Test application speed: coach one thing, watch the next pitch",
         "Praise the asking, not just the applying",
         "If they defend instead of absorb, coach that first — it caps everything"]),
    _module("Self Leadership", "Problem-Solving Mindset",
        "You respond to challenges with solutions, not excuses. You break a problem down into what you can control "
        "and act on it, rather than waiting for someone to fix it for you. The territory, the weather, and the "
        "campaign are inputs — your response is the variable you own.",
        ["Responds to challenges with solutions, not excuses",
         "Breaks problems into controllables and acts on them",
         "Doesn't wait for someone else to fix what they can fix"],
        ["Problems arrive with a proposed solution attached",
         "Observed response to a genuinely bad day",
         "Excuse language absent from debriefs"],
        ["When they bring a problem, ask for their solution before offering yours",
         "Debrief a bad day: what was controllable, what did you control?",
         "Model it — narrate your own controllables out loud"]),
    _module("Self Leadership", "The 8 Steps",
        "You can articulate the purpose of the 8 Steps — attitude, time management, preparation, 100% effort, "
        "working territory, safeguarding your attitude, goals, taking control — and demonstrate them in the field. "
        "They are the operating system of a professional day; Stage 2 means they run without anyone standing over you.",
        ["Can articulate the purpose of each of the 8 Steps",
         "Demonstrates them in the field, unprompted",
         "Uses the steps to self-diagnose a rough day"],
        ["Verbal walkthrough of all 8 with purpose, not just names",
         "Field observation against the steps",
         "Self-debriefs reference specific steps"],
        ["Quiz purpose, not order — parroting isn't knowing",
         "After a rough day, ask which step slipped",
         "Coach one step per week until all eight are habits"]),
    _module("Self Leadership", "Profitability",
        "You know your personal breakeven and the industry averages required to represent the brand, and you use "
        "those numbers to guide daily priorities, decisions, and actions. Breakeven is your needs ÷ £55 (the BA fee "
        "for a standard £12 sign-up), turned into sign-ups a week. A professional knows exactly what a day must "
        "produce — and plans backward from it.",
        ["Knows personal breakeven cold",
         "Knows the industry averages required to represent the brand",
         "Uses these numbers to guide daily priorities and decisions"],
        ["Can state breakeven and averages unprompted",
         "Daily decisions visibly reference the numbers",
         "Weekly results vs. breakeven trend"],
        ["Quiz breakeven monthly — it changes and they should know",
         "Ask how today's plan covers the number",
         "Connect every schedule decision back to profitability"]),

    # ── People Leadership ──────────────────────────────────────────────────
    _module("People Leadership", "GRASP",
        "You can articulate the purpose of G.R.A.S.P and demonstrate it in the office and the field. G.R.A.S.P is "
        "being the best example — preparing for real leadership: Getting with the Right People, Responsibility, "
        "Attitude, Systems, Profit. At Stage 2 it should be visible in how you show up every day, not just "
        "recitable.",
        ["Can articulate the purpose of GRASP",
         "Demonstrates it in the office and the field",
         "Others can see it in their behaviour without being told"],
        ["Verbal walkthrough with purpose",
         "Office + field observation",
         "Peer feedback reflects it"],
        ["Quiz purpose, then point at moments: where was GRASP just now?",
         "Catch them demonstrating it and name it publicly",
         "Coach the gap between knowing it and living it"]),
    _module("People Leadership", "Leading by Example",
        "You lead by example in both behaviour and performance — a visible example of what good looks like. Before "
        "anyone gives you a team, you're already setting the standard: on time, prepared, positive, producing. "
        "People copy what they see long before they follow what they're told.",
        ["Leads by example in behaviour AND performance",
         "Is a visible example of WGLL",
         "Standard holds on bad days, not just good ones"],
        ["Coach observation across a full week",
         "Peers reference them as the example",
         "Behaviour and numbers both at standard"],
        ["Point out who's watching them — newer BAs copy everything",
         "Praise the example specifically, not generically",
         "One off-standard day is coaching; a pattern is a conversation"]),
    _module("People Leadership", "Assuming the Role",
        "You begin to operate as a leader before the title: taking ownership of your standards, your behaviours, and "
        "your influence on others. Advancement recognises what's already happening — Stage 2 is where you start acting "
        "like the leader you intend to become.",
        ["Begins to operate as a leader — ownership of standards and behaviours",
         "Aware of their influence on others and uses it well",
         "Steps up without being asked when the moment needs it"],
        ["Moments of unprompted leadership, observed",
         "Influence on newer BAs is positive and visible",
         "Owns outcomes in team settings"],
        ["Give them small leadership moments — a huddle, a new starter's first hour",
         "Debrief their influence: who did you lift today?",
         "Coach the difference between having the role and assuming it"]),

    # ── Digital & Data ─────────────────────────────────────────────────────
    _module("Digital & Data", "Using Numbers to Self-Coach",
        "You use your numbers to diagnose your own performance and take action to improve. The data tells you which "
        "part of your day leaks — approaches, conversations, closes — and you coach yourself before anyone else has "
        "to.",
        ["Uses their numbers to diagnose their own performance",
         "Takes action from the diagnosis without being told",
         "Can explain performance in numbers, not feelings"],
        ["Self-diagnosis matches what the data shows",
         "Actions follow diagnoses, on their own initiative",
         "KPI improvement trends they drove themselves"],
        ["Hand them their own week and ask for the story in it",
         "Check the action: diagnosis without change is trivia",
         "Wean them off waiting for your read of their numbers"]),
    _module("Digital & Data", "Daily Inputs & Weekly Outputs",
        "You can explain your performance in numbers, not feelings. You know the daily inputs required to hit your "
        "personal targets and you track them in real time — doors, conversations, presentations — because outputs "
        "follow inputs, every single week.",
        ["Knows the daily inputs required to hit personal targets",
         "Tracks inputs in real time, not at day's end",
         "Explains performance in numbers, not feelings"],
        ["Can state today's input counts at any point in the day",
         "Input-to-output maths checks out against their targets",
         "Weeks are planned in inputs, not hopes"],
        ["Ask for their numbers at 2 PM, not 8 PM",
         "Coach the maths: target ÷ averages = today's inputs",
         "Kill feelings-talk in debriefs — numbers first, then context"]),
    _module("Digital & Data", "Clean Data You Can Trust",
        "You track data accurately with no missing fields and no shortcuts — numbers others can rely on without "
        "double-checking. Bad data doesn't just mislead you; it wastes your coach's time and the office's "
        "decisions. At Stage 2, your numbers are simply never the question.",
        ["Tracks data accurately with no missing fields or shortcuts",
         "Data entered same-day, not reconstructed later",
         "Numbers can be relied on without others double-checking"],
        ["Data audits come back clean",
         "Zero chase-ups for missing submissions",
         "Their numbers match reality when spot-checked"],
        ["Spot-check monthly and say so — trusted data is earned",
         "Coach same-day entry: memory is where accuracy dies",
         "Connect their data to a real decision it drove — make it matter"]),
]


# ──────────────────────────────────────────────────────────────────────────
# STAGE 3  ·  Being a Leader  ·  Leaders only
# 30 topics across 6 categories — matches the latest "Stage 3 NEW COD
# Amplifi" curriculum sheet (A. Personal Development, B. Recruiting,
# C. Week One Coaching, D. Working with Stage 2, E. Running Sectors, F. EQ).
# ──────────────────────────────────────────────────────────────────────────


def _s3(category: str, topic: str, content: str, good: list, measured: list,
        coach: list, prompts: dict | None = None) -> dict:
    """Stage-3 module helper. Identical schema to _module() but with stage=3
    and a leadership-flavored default prompt set."""
    default_prompts = {
        "knowledge": f"Can clearly explain {topic.lower()} in a coaching conversation",
        "skill": f"Can demonstrate {topic.lower()} when leading or coaching a teammate",
        "consistency": f"Applies {topic.lower()} reliably week-over-week, not just once",
        "independence": f"Drives {topic.lower()} without admin or peer prompting",
    }
    return {
        "stage": 3,
        "category": category,
        "topic": topic,
        "trainee_content": content,
        "what_good_looks_like": good,
        "how_measured": measured,
        "leader_coaching_notes": coach,
        "assessment_prompts": prompts or default_prompts,
    }


STAGE_3_MODULES = [
    # ── The Standard ───────────────────────────────────────────────────────
    _s3("The Standard", "Stage 3 — The Leader Standard",
        "Stage 3 is creating success in others. Your results now include everyone you coach: their skills, their "
        "quality, their independence. The standard is protected at all times — and the test is whether your team "
        "upholds it when you're not present. Personal profitability holds while you coach; leadership is added to "
        "your production, not instead of it.",
        ["Evidence: can competently sign off a new starter on COD 1",
         "Evidence: conducts a team huddle showing structure and clarity",
         "Evidence: understands the cost of recruitment",
         "Evidence: can show a minimum of 3 days a week of sector targets achieved",
         "Evidence: can hold people accountable to office KPIs"],
        ["Continue maintaining and building on every COD 2 standard",
         "Protects and upholds quality at all times",
         "Team upholds standards without the leader being present",
         "Standards not met = immediate action: retrain or remove responsibility",
         "Maintains personal profitability while coaching"],
        ["Review the evidence list in the weekly rhythm — proof, not stories",
         "Tools to be used daily: Recruiting Pipeline Tracking, Onboarding Checklist",
         "Watch for the classic Stage 3 trap: coaching so much their own numbers die"]),

    # ── Commercial Craft ───────────────────────────────────────────────────
    _s3("Commercial Craft", "Teaching the Sign-Up Process",
        "You can coach the sign-up process in clear, repeatable steps — actively observing technique in roleplay and "
        "real time, and correcting tone of voice, body language, and quality standards as you go. Teaching it is a "
        "different skill from running it: you make the invisible parts visible and transferable.",
        ["Coaches the sign-up process in clear, repeatable steps",
         "Actively observes technique in roleplay and real time",
         "Corrects tone of voice, body language, and quality standards live"],
        ["Can competently sign off a new starter on COD 1",
         "Before/after observation of a new starter they coached",
         "New starter first-sign-up speed and early quality numbers"],
        ["Watch them teach one step — clarity of instruction is the skill",
         "Check transfer: does the new starter still do it two days later?",
         "Coach them off 'watch me' teaching — the new starter must do the reps"]),
    _s3("Commercial Craft", "Diagnosing Sign-Up Problems",
        "You can pinpoint gaps in the 5 Steps and coach trackable improvements — telling an activity problem from a "
        "skill problem from a mindset problem, and coaching accordingly. The diagnosis decides the cure: more doors, "
        "a drilled skill, or a reset attitude are three different prescriptions.",
        ["Pinpoints which of the 5 Steps is leaking",
         "Distinguishes activity vs. skill vs. mindset problems",
         "Coaches trackable improvements against the diagnosis"],
        ["Diagnoses match what the data later confirms",
         "Improvements are trackable and tracked",
         "Coached BAs recover measurably"],
        ["Have them diagnose from observation, then check the numbers together",
         "Quiz the three problem types on real cases",
         "Watch for one-size-fits-all coaching — it means no diagnosis happened"]),
    _s3("Commercial Craft", "Protecting Quality",
        "You consistently protect quality, not just volume — and you coach your people to prioritise quality at "
        "every stage of the sign-up. A team that chases numbers without quality is borrowing from next month: "
        "cancellations give every shortcut back with interest.",
        ["Consistently protects quality, not just volume",
         "Coaches quality standards at every stage of the sign-up",
         "Team quality KPIs hold even during pushes"],
        ["Team 1st/3rd payment rates and cancellation numbers",
         "Quality coaching moments observed in the field",
         "No quality dips during high-volume weeks"],
        ["Watch what they praise — volume-only praise teaches shortcuts",
         "Review their team's quality data together weekly",
         "Roleplay the conversation with a high-volume, low-quality BA"]),
    _s3("Commercial Craft", "Sector Expertise",
        "Sector and site work has its own standard — territory allocation, sector meetings, end-of-day breakdowns, "
        "in-day data. As a Stage 3 leader you build the foundations here; the full standard lives in the Sector/Site "
        "Leader (SL) stage of the COD, which unlocks when you're actively running sectors.",
        ["Understands what running a sector involves ahead of doing it",
         "Supports sector leaders' plans when working in their sectors",
         "Building towards the SL stage deliberately"],
        ["Refer to the Sector/Site Leader COD stage — that sheet is the standard",
         "Contribution observed when working within others' sectors",
         "Readiness conversation with their admin on record"],
        ["Point them at the SL stage modules as the preview",
         "Give them slices of sector responsibility before the full role",
         "Debrief how the sector they worked in was run — what would they copy?"]),

    # ── Self Leadership ────────────────────────────────────────────────────
    _s3("Self Leadership", "Networking",
        "You proactively build relationships beyond your immediate team, and you actively learn from high performers "
        "to accelerate your own development. The best leaders are assembled from a dozen borrowed strengths — go "
        "collect them.",
        ["Proactively builds relationships beyond the immediate team",
         "Actively learns from high performers",
         "Applies what they borrow — visibly"],
        ["Relationships across teams and offices, in evidence",
         "Can name what they learned from whom",
         "Borrowed techniques appearing in their own game"],
        ["Ask who they learned from this month — there should be a name",
         "Connect them deliberately with a strength they lack",
         "Debrief cross-office calls: what did you take?"]),
    _s3("Self Leadership", "Emotional Control Under Pressure",
        "You respond rather than react in challenging situations. You don't avoid tough conversations on "
        "underperformance, and you set a composed tone for the team — pressure reveals the leader, and your team "
        "reads your face before they read the numbers.",
        ["Responds rather than reacts under pressure",
         "Doesn't avoid tough conversations on underperformance",
         "Sets a composed tone for the team on hard days"],
        ["Observed composure in genuinely difficult moments",
         "Tough conversations happening on time, not avoided",
         "Team stays steady when results wobble"],
        ["Debrief their last pressure moment: felt vs. showed",
         "Roleplay the conversation they're dreading",
         "Watch the team's energy on a bad day — it mirrors the leader's"]),
    _s3("Self Leadership", "Weekly Planning Rhythm",
        "You plan the week ahead consistently with clear priorities — what to execute, how, and a review at the end "
        "— and you deliver it without prompting or follow-up. A leader's week is designed, not discovered.",
        ["Plans the week ahead consistently, with clear priorities",
         "Executes and reviews without prompting or follow-up",
         "Priorities are the right ones — impact over busyness"],
        ["Written weekly plan, delivered unprompted",
         "Review happens and feeds the next week's plan",
         "Planned priorities match what the team actually needed"],
        ["Read their plan Mondays; read their review Fridays",
         "Challenge the priorities, not just the existence of a plan",
         "If you had to chase the plan, that IS the coaching topic"]),

    # ── People Leadership ──────────────────────────────────────────────────
    _s3("People Leadership", "High-Clarity Team Meetings",
        "You lead structured, planned team meetings with clear outcomes and actions. Everyone leaves knowing what, "
        "why, and the expectations for action — and the meetings run consistently regardless of your personal "
        "emotion or current results.",
        ["Meetings are structured and planned, with clear outcomes",
         "Everyone leaves knowing what, why, and expected actions",
         "Consistency holds regardless of emotion or current results"],
        ["Conducting a team huddle showing structure and clarity",
         "Spot-poll after: can attendees state the actions?",
         "Meetings happen on schedule in bad weeks too"],
        ["Sit in monthly; score structure, clarity, energy",
         "Test retention: ask an attendee for the three actions",
         "Watch a bad-week meeting — that's where consistency shows"]),
    _s3("People Leadership", "Performance Conversations",
        "You don't avoid tough conversations about underperformance. You address performance gaps early, directly, "
        "and with clarity rather than frustration — and you follow up to ensure the improvements actually happen.",
        ["Addresses performance gaps early, directly, with clarity",
         "Clarity rather than frustration — never sarcasm or vagueness",
         "Follows up to ensure improvements happen"],
        ["Performance issues addressed on record, with dates",
         "Post-conversation improvement visible in numbers",
         "Team members describe feedback as fair, even when hard"],
        ["Roleplay the conversation they're currently avoiding",
         "Check the follow-up trail on their last three conversations",
         "Coach clarity over comfort — kindness is clarity here"]),
    _s3("People Leadership", "Setting & Enforcing Standards",
        "You model the standard yourself first. You can communicate clearly what good looks like in quality, "
        "sign-ups, recruitment, and KPIs — and you hold others accountable when it isn't met. A standard you don't "
        "enforce is a suggestion.",
        ["Models the standard themselves first",
         "Communicates WGLL clearly: quality, sign-ups, recruitment, KPIs",
         "Holds others accountable when the standard isn't met"],
        ["Can hold people accountable to office KPIs",
         "Team knows the standards without asking",
         "Enforcement observed — not just standard-setting"],
        ["Audit one standard: does the team know it, and what happened last miss?",
         "Watch them enforce — tone should be firm, not personal",
         "Their own behaviour is exhibit A; check it first"]),
    _s3("People Leadership", "Building Independence",
        "You develop people to think and act independently by gradually removing support as capability grows. You "
        "coach in a way that builds capability rather than reliance — so you are truly replacing yourself, not "
        "collecting dependents.",
        ["Develops people who think and act independently",
         "Gradually removes support as capability grows",
         "Builds capability, not reliance — replaces themselves"],
        ["Coached BAs make correct calls without checking first",
         "Support visibly steps down over weeks",
         "Team runs a day cleanly without them"],
        ["Count how often their people check in — dependency has a sound",
         "Plan the support step-downs together, with dates",
         "Coach the question-back habit: 'what would you do?'"]),
    _s3("People Leadership", "Emotional Regulation",
        "You coach behaviour without becoming emotionally involved, and you maintain composure when faced with "
        "defensiveness or resistance. The moment coaching becomes personal, it stops being coaching.",
        ["Coaches behaviour without becoming emotionally involved",
         "Maintains composure against defensiveness or resistance",
         "Separates the person from the performance, every time"],
        ["Observed coaching under resistance stays composed",
         "No relationships damaged by coaching conversations",
         "Team brings problems early — a sign coaching feels safe"],
        ["Roleplay a defensive BA and watch their pulse",
         "Debrief any conversation that got heated: where did it turn?",
         "Praise composure specifically when you see it earned"]),
    _s3("People Leadership", "Personal Recruitment",
        "You take ownership of actively building and retaining your own recruitment pipeline. Leaders who wait for "
        "the office to hand them people plateau; leaders who recruit their own team compound. You also understand "
        "the cost of recruitment — every drop-off has a price.",
        ["Takes ownership of building their own recruitment pipeline",
         "Actively retains — the pipeline is warm, not a list",
         "Understands the cost of recruitment"],
        ["Pipeline exists, is current, and produces starters",
         "Can walk the cost of recruitment numbers",
         "Referrals and self-sourced candidates appearing"],
        ["Review their pipeline weekly like a sales number — it is one",
         "Quiz the cost per recruit and what a no-show really costs",
         "Coach retention of candidates, not just collection"]),

    # ── Digital & Data ─────────────────────────────────────────────────────
    _s3("Digital & Data", "Data-Driven New Starter Development",
        "You use numbers daily to guide coaching decisions for your new starters. You track key metrics and take "
        "early action where performance is off track — day-3 data predicts week-2 outcomes, if you're reading it.",
        ["Uses numbers daily to guide new starter coaching",
         "Tracks key metrics per starter",
         "Takes early action when performance is off track"],
        ["Coaching decisions visibly reference starter data",
         "Early interventions dated before the visible slump",
         "Starter retention and ramp speed"],
        ["Ask what the data says about each starter, daily in week one",
         "Post-mortem a lost starter: when did the data first warn?",
         "Coach leading indicators, not just sign-ups"]),
    _s3("Digital & Data", "Tracking Team Progression",
        "You track and review team progress weekly and can see clear trends and weaknesses. You can identify who is "
        "progressing, plateauing, or going backwards — and create clear coaching actions from the data.",
        ["Tracks and reviews team progress weekly",
         "Identifies who is progressing, plateauing, or going backwards",
         "Creates clear coaching actions from the data"],
        ["Weekly team review on record with trends called out",
         "Coaching actions traceable to identified trends",
         "Plateaus get caught and addressed within two weeks"],
        ["Review their team read monthly — do you see what they see?",
         "Every plateau needs a named action; check for both",
         "Compare their calls against the bells and quality data"]),
    _s3("Digital & Data", "Tracking the Recruitment Pipeline",
        "You keep an accurate, up-to-date view of the recruitment pipeline. You identify drop-off points and take "
        "action to improve conversion and retention — recruiting is a funnel, and you manage it like one.",
        ["Keeps an accurate, current view of the pipeline",
         "Identifies drop-off points in the funnel",
         "Acts to improve conversion and retention numbers"],
        ["Pipeline records match reality when checked",
         "Drop-off analysis exists with actions attached",
         "Conversion rates improving stage over stage"],
        ["Walk the funnel together monthly: where do we lose people?",
         "Check record accuracy against what actually happened",
         "Tie one improvement action to one drop-off point at a time"]),
]


# ──────────────────────────────────────────────────────────────────────────
# COD 2026 — Stage 4 "Team Builder" + Stage SL "Sector/Site Leader".
#
# Structure follows the Final Cycle of Development (Aug 2026): capabilities
# grouped by the 4 Pillars, each graded on the proof ladder Know → Do →
# Deliver → Teach → Systemize. The ladder maps onto our four assessment
# dimensions: Know≈knowledge, Do≈skill, Deliver≈consistency,
# Teach/Systemize≈independence. Each stage opens with a "The Standard"
# module carrying the sheet's Evidence Required + Standards & Consequences.
# ──────────────────────────────────────────────────────────────────────────

def _sx(stage: int, category: str, topic: str, content: str, good: list, measured: list,
        coach: list, prompts: dict | None = None) -> dict:
    """Stage 4/5 module helper — same schema as _module()/_s3()."""
    default_prompts = {
        "knowledge": f"Can explain {topic.lower()} and why it matters at this level",
        "skill": f"Can demonstrate {topic.lower()} live, with their team watching",
        "consistency": f"Delivers {topic.lower()} to the standard week after week",
        "independence": f"Teaches {topic.lower()} to others and builds systems around it",
    }
    return {
        "stage": stage,
        "category": category,
        "topic": topic,
        "trainee_content": content,
        "what_good_looks_like": good,
        "how_measured": measured,
        "leader_coaching_notes": coach,
        "assessment_prompts": prompts or default_prompts,
    }


STAGE_4_MODULES = [
    # ── The Standard ───────────────────────────────────────────────────────
    _sx(4, "The Standard", "Stage 4 — The Team Builder Standard",
        "Stage 4 is about embedding systems, standards, and creating independence. You stop being the producer of "
        "results and become the builder of people who produce results. Everything at this stage is judged on one "
        "question: does your team run to the standard when you are not in the room? Not just verbal leadership — "
        "every standard must have a metric and a consequence.",
        ["Evidence: accurate team data captured consistently",
         "Evidence: a full day runs end to end without you present",
         "Evidence: people are moved backward when performance drops — the ladder works both ways",
         "Evidence: quality risks get identified early, with coaching solutions attached",
         "Evidence: regular advancements into leadership — the pipeline keeps producing"],
        ["Continues maintaining and building on every Stage 3 standard",
         "Underperformance that repeats gets documented, time-bound action",
         "Repeated misses pause progression",
         "Personal profitability and quality standards hold while building others"],
        ["Review this standard at the start of every Stage 4 coaching cycle",
         "Ask for the evidence, not the story — each item above is checkable",
         "If a standard has no metric and no consequence, it isn't a standard yet"]),

    # ── Commercial Craft ───────────────────────────────────────────────────
    _sx(4, "Commercial Craft", "Teaching Advanced Sign-Up Psychology",
        "At Stage 4 you can teach the psychology behind supporter decision-making — why people say yes, what builds "
        "trust in seconds, and how urgency works without pressure — and coach BAs to apply it naturally, ethically, "
        "and effectively. This is elevated, next-level sign-up skill: not running the 5 Steps yourself, but making "
        "the reasoning behind them transferable.",
        ["Teaches the why behind each step, not just the what",
         "BAs coached by them apply psychology naturally — it never sounds scripted",
         "Keeps it ethical: influence that leaves the supporter feeling good about the decision"],
        ["A BA they coached explains the psychology back correctly",
         "Roleplay observation: their teaching lands in the BA's next live pitch",
         "Quality metrics hold or rise as skills advance"],
        ["Have them teach one psychological principle in a huddle and watch the room",
         "Check for transfer a week later — did the coached BA keep the behaviour?",
         "Correct any drift towards pressure tactics immediately"]),
    _sx(4, "Commercial Craft", "Coaching to Protect Long-Term Quality",
        "You coach the cause and USP of each specific campaign, and you use quality data to find coaching priorities "
        "proactively — before problems appear in the numbers, not after. You help BAs understand why quality matters "
        "to their own earnings and the office's future, and you follow up until the behavioural change sticks.",
        ["Coaches quality from data trends, not incidents",
         "BAs can explain why quality matters, not just recite the rules",
         "Follows up after coaching to confirm the change held"],
        ["Quality KPIs (1st/3rd payment, cancellations) trend stable or up",
         "Coaching priorities visibly come from the data, ahead of problems",
         "Spot-checks show coached behaviours still in place weeks later"],
        ["Ask: what does the quality data say your top three coaching priorities are?",
         "Watch one quality coaching conversation end to end",
         "Audit follow-up: pick one past intervention and check it stuck"]),
    _sx(4, "Commercial Craft", "Advancing First-Generation Leaders",
        "You continue to build first-generation leaders who can lead, coach, and make decisions effectively without "
        "relying on you. The test of a Stage 4 builder isn't how good their leaders look next to them — it's how "
        "good those leaders are when left alone with a team and a decision.",
        ["Their leaders run huddles, coaching, and standards without help",
         "Decisions get made at the right level instead of escalating to them",
         "The leadership bench is deeper every month"],
        ["A first-generation leader signs off a new starter on Stage 1 unaided",
         "Team performance holds when the Stage 4 steps away for a full day",
         "Advancement record: regular advancements out of their team"],
        ["Track who they are advancing right now — there should always be a name",
         "Push decisions back down: 'what would your coach do?'",
         "Review each leader's independence monthly, not just their numbers"]),
    _sx(4, "Commercial Craft", "Scaling Beyond Personal Production",
        "You no longer need to personally carry the team's numbers. You delegate responsibility instead of becoming "
        "the bottleneck — moving from producer of results to builder of people who produce results. Your output is "
        "measured in what your people deliver, and the structure keeps working when you step out.",
        ["Delegates real responsibility, not just tasks",
         "Team results don't collapse when they step out of production",
         "Builds capacity ahead of need instead of firefighting"],
        ["Team total holds on days they don't personally sell",
         "Named owners exist for every key responsibility",
         "A full day runs end to end without them present"],
        ["Check the delegation map — who owns what, and do they know it?",
         "Plan a deliberate step-back day and review what wobbled",
         "Coach them off any task only they can do — that's the bottleneck"]),

    # ── Self Leadership ────────────────────────────────────────────────────
    _sx(4, "Self Leadership", "Emotional Regulation While Coaching",
        "You separate the person from the performance problem. You don't get defensive when challenged, you reset "
        "quickly after a difficult coaching interaction, and you stay consistent — your team never has to guess what "
        "mood their leader is in before bringing you a problem.",
        ["Same steady presence on the worst day as the best day",
         "Takes challenge without defensiveness",
         "Resets fast after hard conversations — the next person gets a clean slate"],
        ["Team members bring problems early instead of hiding them",
         "Observed coaching stays composed under pushback",
         "No 'check the mood first' culture on the team"],
        ["Debrief their hardest recent conversation — what did they feel vs. show?",
         "Watch for leakage: sarcasm, sighs, cold shoulders after a miss",
         "Praise composure specifically when you see it under real pressure"]),
    _sx(4, "Self Leadership", "Handling Conflict & Underperformance",
        "You don't avoid conflict or let it drag on, and you don't confuse fairness with keeping everyone happy. "
        "Underperformance gets addressed with speed and fairness — clear expectations, a real chance to improve, "
        "and a decision — then the team moves forward once the issue is resolved.",
        ["Addresses issues within days, not weeks",
         "Fair process: clear expectation, support, deadline, decision",
         "Once resolved, it's resolved — no lingering grudges or replays"],
        ["Documented, time-bound plans exist for repeated underperformance",
         "Conflicts close with both a decision and a working relationship",
         "Team surveys/retention don't show festering issues"],
        ["Review their open underperformance cases — is each one time-bound?",
         "Roleplay the conversation they are avoiding",
         "Check the aftermath of past conflicts: resolved or just quiet?"]),
    _sx(4, "Self Leadership", "Environment & Culture",
        "You can identify when culture and atmosphere are contributing to retention or performance problems, and "
        "you take action. You create and protect an environment where positivity and high standards are something "
        "people want to be part of — a team culture that is both fun and professional, and strong enough that it "
        "doesn't depend solely on the owner.",
        ["Reads the room and acts on culture problems early",
         "Standards and fun coexist — neither is sacrificed for the other",
         "Culture holds when they're away — it lives in the team, not one person"],
        ["Retention numbers in their team",
         "New starters describe the team the way you'd want them to",
         "Culture survives their holiday"],
        ["Ask what the culture problem is right now — there always is one",
         "Watch a morning meeting for energy vs. discipline balance",
         "Check whose energy the room depends on — it shouldn't be one person's"]),
    _sx(4, "Self Leadership", "Profitability vs. Spending",
        "You know the key numbers that determine office profitability. You personally budget and plan ahead, and "
        "you invest deliberately in people for development and growth — spending where it compounds, cutting where "
        "it doesn't. Profit funds the mission; you treat it that way.",
        ["Knows the office's break-even and margin drivers cold",
         "Budgets ahead instead of reacting to shortfalls",
         "Investment decisions tie to development and growth, not habit"],
        ["Can walk through office profitability numbers unprompted",
         "Spending plans exist before the money moves",
         "Investments show a return in people or performance"],
        ["Quiz the numbers monthly: break-even, cost per recruit, margin per BA",
         "Review one recent spend: what was the expected return, did it land?",
         "Coach the balance — underspending on people is also a failure mode"]),

    # ── People Leadership ──────────────────────────────────────────────────
    _sx(4, "People Leadership", "Clear Expectations Meetings",
        "You set expectations with leaders clearly and specifically. Standards and their enforcement are "
        "communicated quickly and consistently — everyone leaves an expectations meeting knowing exactly what is "
        "required, by when, and what happens if it isn't met.",
        ["Expectations are specific, measurable, and dated",
         "Every standard carries a consequence — and it's enforced",
         "No one is ever surprised by an accountability conversation"],
        ["Leaders can repeat their expectations back accurately",
         "Written record of expectations set and reviewed",
         "Enforcement actually happens when a standard is missed"],
        ["Sit in on one expectations meeting per month",
         "Test a leader afterward: what exactly was agreed?",
         "Audit enforcement: find one missed standard and trace what happened"]),
    _sx(4, "People Leadership", "Coach the Coach",
        "You can observe another leader coaching and improve their coaching ability — with visible improvements "
        "showing up in the data. You work the full leadership loop: watch the coach, coach the coach, then confirm "
        "the change reached the BA on the doors.",
        ["Observes coaching without taking over",
         "Feedback to the coach is specific and behavioural",
         "The improvement shows up two levels down — in the BA's results"],
        ["A coached leader's BAs improve measurably",
         "Before/after observations of the same leader coaching",
         "The leader can articulate what they changed and why"],
        ["Shadow a coaching session together, compare notes after",
         "Have them coach one leader on one behaviour for two weeks — track it",
         "Guard against hero-coaching: they improve the coach, not the BA directly"]),
    _sx(4, "People Leadership", "Preventing Dependency",
        "You develop people who can think and solve problems without constantly checking in. You build independence "
        "deliberately — coaching in a way that builds capability rather than reliance, gradually removing support as "
        "capability grows, so you are truly replacing yourself.",
        ["Answers questions with questions when the person should know",
         "Support is scaffolding — it comes down on a schedule",
         "People stop asking permission for decisions inside their remit"],
        ["Escalations to them decrease month over month",
         "Their people make correct calls without checking first",
         "A full day runs without them being consulted"],
        ["Count their interruptions for a day — each one is a dependency signal",
         "Coach the phrase: 'what do you think, and what would you do?'",
         "Review which supports can come down this month"]),
    _sx(4, "People Leadership", "Mentoring Through Business Cycles",
        "You coach people to focus on controllables and the right actions through highs and lows — recruitment pushes, "
        "slow seasons, campaign changes. You build each person's ability to navigate the next cycle independently, "
        "so experience compounds into judgement.",
        ["Normalises cycles — no panic in dips, no complacency in peaks",
         "Coaches controllables: activity, quality, attitude",
         "Each cycle leaves the person more self-sufficient than the last"],
        ["Team performance stability across seasonal swings",
         "People reference past cycles when handling new ones",
         "Retention through downturns"],
        ["In a dip, check what they're coaching: effort and inputs, or mood?",
         "Have them write the playbook for the next slow season",
         "Debrief every cycle: what will your people do alone next time?"]),

    # ── Digital & Data ─────────────────────────────────────────────────────
    _sx(4, "Digital & Data", "Using KPIs to Coach",
        "You find root causes in the numbers, and you teach leaders how to understand and use their own KPIs. Data "
        "is your coaching language: every intervention starts from what the numbers say and ends with a measurable "
        "expected change.",
        ["Reads a KPI sheet and lands on the real cause, not the symptom",
         "Leaders they develop self-diagnose from their own numbers",
         "Every coaching action has a metric attached"],
        ["Leaders can walk their own KPIs unprompted",
         "Coaching actions reference specific numbers and expected movement",
         "Root-cause calls prove out over the following weeks"],
        ["Hand them a KPI sheet cold and ask for the story in it",
         "Check their leaders: who can self-diagnose, who still needs the answer?",
         "Trace one intervention: metric before, action, metric after"]),
    _sx(4, "Digital & Data", "Predicting Issues Early",
        "You can distinguish a one-off dip from an emerging pattern, and you anticipate problems before they cost a "
        "week. You use tools like AI and automation to catch what a manual review would miss — the numbers warn you "
        "early, and you act early.",
        ["Separates noise from signal in performance data",
         "Acts on patterns before they become results",
         "Uses tooling to widen what they can see"],
        ["Interventions dated before the visible drop, not after",
         "Predictions they've made that proved out",
         "Automated checks or reports they've put in place"],
        ["Ask for one prediction a week — review the hit rate together",
         "Post-mortem any surprise: what pattern was visible in hindsight?",
         "Introduce one new tool or report per quarter and check adoption"]),
    _sx(4, "Digital & Data", "Tracking Progression & Retention",
        "You keep team reporting accurate and consistent, and you track movement through each stage — not just "
        "overall headcount. You can identify when and where people drop out, and you hold leaders accountable for "
        "the progression and retention of their people.",
        ["Knows exactly who is at which stage and who is stuck",
         "Spots drop-off points in the pipeline and fixes the stage, not the person",
         "Leaders answer for their people's progression, not just their sales"],
        ["Stage-by-stage progression report exists and is current",
         "Drop-off analysis with actions attached",
         "Retention and advancement rates by leader"],
        ["Review the progression board weekly — every stuck name needs a plan",
         "Compare leaders' retention side by side and coach the gap",
         "Celebrate advancement publicly — what gets tracked and praised repeats"]),
]


STAGE_SL_MODULES = [
    # ── The Standard ───────────────────────────────────────────────────────
    _sx(5, "The Standard", "Stage SL — The Sector Leader Standard",
        "The Sector/Site Leader runs performance management on the ground: territory, targets, quality, and the "
        "team's belief — all owned by you for your sector or site. The standard is simple: the sector performs, on "
        "target and on quality, without the owner stepping in to keep it functioning. This stage unlocks when you "
        "are actively running sectors or sites.",
        ["Evidence: sector/site target hit or exceeded four days out of the week",
         "Evidence: sector averages measurably up across a week",
         "Evidence: independently runs a sector for a full week — performance and quality hold without the owner"],
        ["Non-negotiables: data submission, protecting territory, present for end-of-day sector reviews",
         "Standards missed repeatedly while leading a sector = responsibility removed"],
        ["Review the three evidence items weekly — that's the role",
         "The non-negotiables are pass/fail, not coaching topics",
         "If the owner had to step in this week, find out why before anything else"]),

    # ── Commercial Craft ───────────────────────────────────────────────────
    _sx(5, "Commercial Craft", "Territory Allocation & Protection",
        "You research and allocate territory across the map to give every BA the best chance of hitting target — "
        "and for site work, you research and set up the stand in the correct position for the same reason. Territory "
        "is an asset: you protect it, plan it, and never burn it.",
        ["Allocations account for footfall, history, and each BA's level",
         "Territory records stay accurate — no double-knocking, no waste",
         "Stand placement is researched, not habitual"],
        ["Allocation plan shared with the team before the day starts",
         "Territory disputes and overlaps at zero",
         "Target hit-rate by allocated patch"],
        ["Review one day's allocation plan against results — was the map right?",
         "Check protection: is anything being re-knocked too soon?",
         "Have them explain a placement decision with data"]),
    _sx(5, "Commercial Craft", "Understanding Territory Differences",
        "You can identify and coach your sector on different demographics and territory variances that affect "
        "results — housing type, age profile, culture, timing — and adjust the plan and the pitch accordingly. The "
        "same pitch doesn't work on every street, and you teach your team why.",
        ["Reads a patch and predicts what will work before knocking starts",
         "Coaches approach changes per territory, specifically",
         "Adjusts timing and rotation to the area's rhythm"],
        ["Averages hold across different territory types",
         "BAs can explain how today's patch changes their approach",
         "Rotation plan reflects known area differences"],
        ["Quiz them on today's patch: who lives there and what lands?",
         "Compare their sector's performance across area types",
         "Watch one coaching moment about adapting to the area"]),
    _sx(5, "Commercial Craft", "Start-of-Day Sector Meetings",
        "You run a strong start-of-day sector meeting that gives clear direction and sets the team up for success — "
        "targets for the day, territory plan, one focus skill, and real energy. Ten minutes that decide the day.",
        ["Every BA leaves knowing target, patch, and focus",
         "Energy is set deliberately — the meeting is a launch, not an admin recap",
         "Short, sharp, consistent — same structure every day"],
        ["Observed meeting hits direction + energy in under 15 minutes",
         "BAs can repeat their target and focus at midday",
         "Day performance vs. days with weak or missed meetings"],
        ["Watch one start-of-day monthly against a simple rubric",
         "Check retention at midday: does the team still know the plan?",
         "Coach the energy: direction without belief doesn't move numbers"]),
    _sx(5, "Commercial Craft", "End-of-Day Sector Breakdown",
        "You run a detailed end-of-day breakdown so every BA leaves knowing their educational plan for tomorrow — "
        "what the numbers said, what caused them, and exactly what each person works on next. The breakdown is "
        "where today's results become tomorrow's coaching.",
        ["Reviews numbers person by person, cause by cause",
         "Every BA leaves with one specific thing to improve tomorrow",
         "Present for it every working day — it's a non-negotiable"],
        ["Breakdown happens daily, on record",
         "Next-day focus items exist per BA and get followed up",
         "Averages trend up as breakdown coaching compounds"],
        ["Sit in on one breakdown a month",
         "Next morning, ask a BA what their focus is — it should match",
         "Check the loop: yesterday's focus reviewed in today's breakdown"]),
    _sx(5, "Commercial Craft", "Identifying & Correcting Quality",
        "You identify quality and conduct issues inside your sector and act to correct them — fast. Quality "
        "problems caught at the doorstep cost a conversation; caught at cancellation they cost everyone. You watch "
        "for the early signals and retrain the same day.",
        ["Spots quality drift in the field, not in next week's report",
         "Corrects conduct issues immediately and directly",
         "Retrains same-day; escalates when correction doesn't hold"],
        ["Sector quality KPIs (donations, cancellations) stay on standard",
         "Same-day retrain record for issues found",
         "Zero conduct issues surfacing later that they should have caught"],
        ["Ask for the last quality issue they caught and what they did",
         "Cross-check their sector's quality data against their reports",
         "Roleplay the conduct conversation they least want to have"]),
    _sx(5, "Commercial Craft", "Setting Sector Targets",
        "You set sector and site targets and break them down into clear individual expectations that people are "
        "held accountable to. Targets come from the numbers — territory, form, campaign — and every BA knows their "
        "share of the day before it starts.",
        ["Targets are grounded in data, stretch but real",
         "Broken down per person, per day — never just a sector total",
         "Accountability follows: targets get reviewed, not just set"],
        ["Individual targets visible each morning",
         "Four days out of the week the sector target is hit or exceeded",
         "BAs can state their own target and why it's theirs"],
        ["Check the maths: does the per-person breakdown add up to the target?",
         "Watch one accountability moment when a target's missed",
         "Coach against sandbagging and against fantasy targets equally"]),

    # ── Self Leadership ────────────────────────────────────────────────────
    _sx(5, "Self Leadership", "Leading the Situation",
        "You set your own priorities without direction, based on what the sector and the team need — and you spot "
        "declining ratios before they become poor results. Nobody tells a sector leader where to look; the numbers "
        "and the field tell you, and you act first.",
        ["Chooses the right priority unprompted, daily",
         "Catches ratio decline early and intervenes",
         "Owner never has to point them at the problem"],
        ["Priority calls they made before being asked",
         "Ratio interventions dated before the results dipped",
         "Owner step-ins at zero for the week"],
        ["Morning check: what's your priority today and why?",
         "Review one early catch and one they missed — what was visible?",
         "If you had to direct them this week, coach that gap first"]),
    _sx(5, "Self Leadership", "Full Ownership of Sector Results",
        "You take full ownership of sector results, and you can identify the root cause behind poor performance — "
        "not just report that it happened. No excuses about territory, weather, or the team you were given: the "
        "sector's number is your number.",
        ["Speaks in causes and fixes, never in blame",
         "Digs past the first explanation to the real driver",
         "Owns the miss publicly and the plan personally"],
        ["Root-cause analysis for any down week, with actions",
         "Fixes address causes and results recover",
         "Zero deflection in reviews"],
        ["Push past their first answer: 'and what caused that?'",
         "Compare their diagnosis against the data yourself",
         "Praise ownership loudly — it's the culture you're building"]),
    _sx(5, "Self Leadership", "High-Level Planning & Organization",
        "You plan impacts based on your team and territory, and you can pivot daily for specific coaching "
        "interventions. The week is planned ahead — impacts, rotations, focus skills — but the plan serves the "
        "sector, not the other way around.",
        ["Weekly plan exists before Monday: impacts, patches, priorities",
         "Pivots fast when the day demands it, without losing the week",
         "Impacts are specific to people and territory, not generic"],
        ["Written weekly plan, reviewed against what actually happened",
         "Daily pivots that addressed real needs",
         "Impact sessions land with the right BA at the right time"],
        ["Review their week plan every Monday for two months",
         "Check one pivot: was it reactive noise or a real read?",
         "Coach impact specificity — 'who is this for and what changes?'"]),
    _sx(5, "Self Leadership", "Emotional Control When Results Are Down",
        "You maintain emotional control in front of the sector when results are down. You create urgency without "
        "fear or negativity, challenge poor performance without souring the environment, and keep your own "
        "frustration separate from what the team needs from you.",
        ["Down days get urgency and belief, not blame and gloom",
         "Challenges performance while keeping the environment positive",
         "The team can't read panic off them, ever"],
        ["Team energy holds through bad days",
         "Observed down-day leadership stays composed and constructive",
         "No fear-based behaviour: hiding numbers, avoiding the sector leader"],
        ["Watch them on a bad day — that's the real assessment",
         "Debrief: what did you feel vs. what did you show?",
         "Roleplay delivering urgency without threat"]),

    # ── People Leadership ──────────────────────────────────────────────────
    _sx(5, "People Leadership", "Diagnosing Where BAs Lose Sign-Ups",
        "You can diagnose where BAs are losing sign-ups in your sector — which of the 5 or 8 Steps is leaking — "
        "and retrain efficiently. You watch, you pinpoint, you fix the specific skill gap, and you confirm the fix "
        "in the next set of numbers.",
        ["Names the exact step where each struggling BA leaks",
         "Retrains the specific gap, not the whole pitch",
         "Confirms the fix in results, not vibes"],
        ["Diagnosis → retrain → measurable recovery, on record",
         "Observed field diagnosis matches the data",
         "Retrains are short and targeted"],
        ["Have them diagnose one BA from observation, then check the numbers",
         "Watch one retrain: is it the step, or everything?",
         "Track recovery time from diagnosis to result"]),
    _sx(5, "People Leadership", "Building Belief, Energy & Belonging",
        "You recognise progress and small wins — not just sign-ups. You build relationships beyond your immediate "
        "team, you know when morale or belief is dropping, and you intervene early. A sector runs on belief as much "
        "as skill, and belief is built deliberately.",
        ["Celebrates progress and effort, not only results",
         "Reads morale drops early and acts before they spread",
         "Everyone in the sector feels seen — including the quiet ones"],
        ["Recognition moments visible daily",
         "Early interventions on morale, before performance dipped",
         "Sector retention and energy"],
        ["Count recognition vs. correction for a day — check the ratio",
         "Ask who's struggling that isn't showing it in numbers yet",
         "Watch the room respond when they walk in"]),
    _sx(5, "People Leadership", "Performance Conversations",
        "You use data to manage performance and diagnose why, rather than jumping to conclusions. You support with "
        "accountability, adapt the conversation to the individual without lowering the standard, and deliver "
        "difficult feedback that leaves the BA with clarity, ownership, and belief they can improve.",
        ["Opens with data, asks before concluding",
         "Adapts tone per person; never adapts the standard",
         "BA leaves clear, owning it, and believing they can fix it"],
        ["Observed conversations end with agreed actions",
         "Performance improves after conversations, relationship intact",
         "BAs describe feedback as fair, even when hard"],
        ["Roleplay their hardest pending conversation",
         "Watch one live: does the BA leave with clarity AND belief?",
         "Check follow-through on the agreed actions"]),
    _sx(5, "People Leadership", "Raising the Sector's Average",
        "You can raise average performance across the sector — not just carry it with your own numbers or one "
        "star's. The middle of the pack is your leverage: small lifts across everyone beat a hero day from anyone.",
        ["Coaches the middle, not just the top and bottom",
         "Sector average trends up over weeks, not just spikes",
         "Improvement is broad-based — check everyone's line, not the total"],
        ["Sector average up across a week, sustained",
         "Per-BA averages: more people above the line each week",
         "Performance spread narrowing as the middle lifts"],
        ["Review per-person averages weekly, not just the sector total",
         "Pick one middle performer per week for focused coaching",
         "Guard against carrying: their own numbers shouldn't hide the team's"]),
    _sx(5, "People Leadership", "Setting the Pace Personally",
        "You visibly demonstrate — not just verbally describe — the work rate, intensity, and results required to "
        "run a sector. When you're in the sector, the standard and pace of the people around you rise. That's the "
        "test: presence that lifts performance.",
        ["First in, highest energy, visible standards",
         "Demonstrates on the doors when the moment calls for it",
         "Others' pace measurably lifts when they're present"],
        ["Sector performance on days they're present vs. absent",
         "Observed field presence: demonstration, not just watching",
         "BAs cite their example unprompted"],
        ["Shadow half a day: are they lifting the pace or just watching it?",
         "Check the presence effect in the numbers",
         "Coach the balance: pace-setting isn't doing everyone's work for them"]),

    # ── Digital & Data ─────────────────────────────────────────────────────
    _sx(5, "Digital & Data", "Sector KPIs on Field IQ",
        "You use Field IQ sector data throughout the day to drive earnings — not as an end-of-day report card. "
        "Ratios, conversion, and per-BA numbers are live instruments: you read them at lunch, not at midnight, and "
        "the afternoon plan changes because of them.",
        ["Checks sector data during the day and acts on it",
         "Understands every sector KPI and what moves it",
         "Explains performance in numbers, not feelings"],
        ["Midday adjustments traceable to live data",
         "Can walk their sector's KPIs cold at any point in the day",
         "Earnings impact from in-day decisions"],
        ["Call at midday: what do the numbers say and what are you changing?",
         "Quiz the KPIs — definitions, current values, levers",
         "Trace one in-day pivot from data to result"]),
    _sx(5, "Digital & Data", "Spotting Trends Early",
        "You identify problems quickly using the data presented to a sector leader — not waiting until the end of "
        "the day, and never until the end of the week. A two-hour dip caught at noon costs an adjustment; the same "
        "dip found at 9 PM cost the day.",
        ["Catches in-day dips while there's still day left to fix them",
         "Distinguishes a blip from a pattern before overreacting",
         "Weekly trends tracked so coaching stays specific and relevant"],
        ["Interventions timestamped mid-day, not post-hoc",
         "Trend calls that proved right",
         "Impacts, prime time, and roleplay all reference tracked territory data"],
        ["Ask what the data said at noon today, and what they did",
         "Review one week of their trend notes",
         "Post-mortem a missed dip: when was it first visible?"]),
    _sx(5, "Digital & Data", "Accurate Sector Reporting",
        "You hold your sector accountable for accurate Field IQ data — every field, every day, no shortcuts — and "
        "you track territory data across the week so impacts, prime-time roleplay, and coaching are specific and "
        "relevant. Bad data doesn't just mislead you; it wastes everyone's coaching.",
        ["Sector's Field IQ is complete and accurate daily",
         "Chases gaps same-day, coaches repeat offenders",
         "Weekly territory picture drives the coaching calendar"],
        ["Data audit: no missing fields across the sector",
         "Coaching topics visibly sourced from the week's data",
         "Data disputes at zero — the numbers are trusted"],
        ["Spot-audit their sector's data weekly",
         "Check the chain: this week's data → next week's impacts",
         "Coach them to make accuracy a sector norm, not a nag"]),
]



def all_seed_modules() -> list:
    """Returns every module as a flat list with sequence numbers assigned.

    Modules are enriched in-place with curated content from the
    Leadership Toolkit + Impact Booklet (see core/module_content.py)
    so the trainee_content / what_good_looks_like / leader_coaching_notes
    fields here serve as a fallback only — newly-seeded office copies
    automatically inherit the curated material."""
    # COD 2026: the seed content below IS the curated curriculum (derived
    # from the Final Cycle of Development). The legacy module_content.py
    # enrichment overlay was written for the pre-2026 topic sets and no
    # longer applies.
    out: list = []
    seq = 0
    for m in STAGE_1_MODULES + STAGE_2_MODULES + STAGE_3_MODULES + STAGE_4_MODULES + STAGE_SL_MODULES:
        seq += 1
        out.append({**m, "sequence": seq, "assessment_bands": ASSESSMENT_BANDS})
    _apply_simplified_overlay(out)
    return out


def _apply_simplified_overlay(modules: list) -> None:
    """Sep-2026 plain-English rewrite (owner: simplify every content
    library). Live prod docs were rewritten directly; this overlay makes
    NEW office copies and fresh deployments seed with the same simplified
    text, without rewriting the historical curriculum source above.
    Keyed by (stage, topic) — module identity. WGLL bullet counts in the
    overlay match the originals exactly (tick-boxes are index-tracked);
    a mismatched entry is skipped rather than risk misaligned ticks."""
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "seed" / "cod_content_simplified.json"
    try:
        overlay = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    except Exception:
        logger.exception("cod_content_simplified.json unreadable — seeding raw content")
        return
    for m in modules:
        entry = overlay.get(f"{m.get('stage')}|{m.get('topic')}")
        if not entry:
            continue
        wgll = entry.get("what_good_looks_like")
        if wgll is not None and len(wgll) != len(m.get("what_good_looks_like") or []):
            logger.warning("simplified overlay skipped (WGLL count) for %s", m.get("topic"))
            continue
        for field in ("trainee_content", "what_good_looks_like", "how_measured",
                      "leader_coaching_notes", "assessment_prompts"):
            if entry.get(field) is not None:
                m[field] = entry[field]
