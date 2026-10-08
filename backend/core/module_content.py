"""Curated training-module content (Stage 2 + Stage 3) sourced from the
Leadership Development Toolkit and Impact Booklet.

Used by:
  • core/module_seed.py — to enrich newly-seeded modules
  • scripts/enrich_modules.py — one-time migration of existing rows

Keys must match `topic` field of seeded modules. Each entry overrides
trainee_content, what_good_looks_like, and leader_coaching_notes.
"""
from typing import Dict, List, TypedDict


class ModuleEnrichment(TypedDict):
    trainee_content: str
    what_good_looks_like: List[str]
    leader_coaching_notes: List[str]


# ─── Stage 2 — Independence ──────────────────────────────────────────────────

STAGE_2_CONTENT: Dict[str, ModuleEnrichment] = {
    "Understanding Direct Sales": {
        "trainee_content": "Door-to-door fundraising is the model of taking a cause straight to the people who can support it — face-to-face, without middlemen. You'll learn how it differs from online giving and TV appeals, why building rapport is the engine of every sign-up, and how the Law of Averages turns activity into predictable results. Master the full sales cycle from approach to close, and the communication skills that turn cold doors into warm conversations.",
        "what_good_looks_like": [
            "Explains door-to-door fundraising vs. online and TV appeals in 30 seconds",
            "Speaks confidently about why our model works for the supporter",
            "Can recite the Law of Averages and apply it to daily activity",
            "Demonstrates each stage of the sales cycle in roleplay",
            "Builds rapport in the first 60 seconds at the door",
        ],
        "leader_coaching_notes": [
            "Use real-world examples and your own field stories to illustrate the model",
            "Roleplay full sales cycles, especially the open and rapport phase",
            "Track averages with them weekly so they see the maths working",
            "Reframe rejection as data, not failure — keep their drive intact",
        ],
    },
    # NOTE: "Company History", "Finances", "International Growth Opportunities"
    # and "The One Principle" were deliberately REMOVED from this enrichment
    # layer (2026-08 content audit): their entries were vaguer than the seed
    # text in core/module_seed.py — no actual facts behind graded recall, a
    # flipped meaning on Finances, and a One Principle that never stated the
    # principle. With no enrichment key, the specific seed text wins at
    # office-seed time. Live offices are healed by core/content_fixes.py.
    "Industry Reach": {
        "trainee_content": "The face-to-face fundraising industry is vast and dynamic. You'll explore its scale, the major players, and where we sit within it. Knowing how we differentiate from competitors lets you talk to supporters with conviction and use the right value proposition for each conversation. The industry is bigger than the office you walk into — you're part of something growing.",
        "what_good_looks_like": [
            "Describes the size and scope of the face-to-face fundraising industry",
            "Names key competitors and how we differ",
            "Articulates our unique value proposition cleanly",
            "Uses industry terminology correctly in conversations",
            "Speaks confidently about our market position",
        ],
        "leader_coaching_notes": [
            "Share industry stats so they see the size of the prize",
            "Walk through specific competitor comparisons",
            "Roleplay scenarios where they need to highlight our edge",
            "Encourage them to read industry news weekly",
        ],
    },
    "Advancement Criteria": {
        "trainee_content": "Every level in this business has clear criteria for advancement — and it's on you to know them cold. Understanding what earns advancement lets you set focused goals and direct your effort to the behaviours and results that move you up. Advancement is never an accident; it's the predictable outcome of consistent work against the right metrics.",
        "what_good_looks_like": [
            "Lists the requirements for the next level word-for-word",
            "Knows the performance metrics used for evaluation",
            "Has personal goals aligned with the criteria",
            "Tracks progress weekly against each criterion",
            "Asks for feedback on what's blocking advancement",
        ],
        "leader_coaching_notes": [
            "Walk them through every advancement criterion with examples",
            "Help them set specific, measurable mini-goals per criterion",
            "Give regular feedback on where they stand vs. each metric",
            "Celebrate hits the moment they happen — make criteria visible",
        ],
    },
    "GRASP": {
        "trainee_content": "G.R.A.S.P is being the best example — preparing for real leadership: Getting with the Right People, Responsibility, Attitude, Systems, Profit. Get with the Right People: find the best people to network with and learn from, and choose the right environment. Take Responsibility for your actions, behaviours and efforts. Bring the Attitude: optimistic, solution orientated, a student mentality — have fun and promote positives. Follow the Systems: have a plan, schedule, agenda and structure. And Profit: following the principles and proven systems grows your profits — and growing your profits grows the opportunity.",
        "what_good_looks_like": [
            "Names each letter of G.R.A.S.P and what it stands for",
            "Maps recent leadership moments to a specific letter",
            "Uses G.R.A.S.P as a daily checklist for their own behaviour",
            "Balances all five instead of leaning on a favourite",
            "Reviews their week against the G.R.A.S.P structure",
        ],
        "leader_coaching_notes": [
            "Walk through G.R.A.S.P letter by letter with concrete examples",
            "Use G.R.A.S.P to debrief real leadership moments as they happen",
            "Catch them when they default to one letter over the others",
            "Drill the acronym until reciting all five is automatic",
        ],
    },
    "Have Fun and Promote Positives": {
        "trainee_content": "Energy is contagious — your attitude shapes the room before your words do. You'll learn to keep your tone enthusiastic and supportive, especially when things get hard, because positivity is the multiplier on every other skill you have. Celebrating small wins, lifting teammates, and laughing through grind days is what builds the kind of culture people don't want to leave.",
        "what_good_looks_like": [
            "Brings consistent positive energy to the office",
            "Actively contributes to a fun, supportive team atmosphere",
            "Celebrates teammate wins as loudly as their own",
            "Stays optimistic when facing setbacks or hard days",
            "Encourages others when motivation dips",
        ],
        "leader_coaching_notes": [
            "Model the energy you want — your team mirrors you",
            "Build rituals (morning music, win bell, celebrations)",
            "Catch and redirect negativity early before it spreads",
            "Recognise positivity publicly so it gets repeated",
        ],
    },
    "Importance of Profitability": {
        "trainee_content": "Profitability is what keeps the doors open and the incentives paid. You'll understand how every individual contribution rolls up into the company's bottom line — and how efficient effort, not just busy effort, is what drives growth. Once you see the link between your personal output and the business's health, the choices you make every day get sharper.",
        "what_good_looks_like": [
            "Explains how individual sign-ups tie to company profit",
            "Identifies waste or inefficiency in their own day",
            "Suggests ways to lift output without working longer",
            "Treats time and gear like business assets",
            "Connects profit to long-term opportunity and advancement",
        ],
        "leader_coaching_notes": [
            "Show the chain: BA activity → office gross → company profit",
            "Share examples where small changes added up to big wins",
            "Encourage them to find their own efficiency upgrades",
            "Reinforce that profitable offices grow leaders the fastest",
        ],
    },
    "Personal Breakeven": {
        "trainee_content": "Your personal breakeven is the income you must earn just to keep the lights on. Calculating it is non-negotiable — once you know the number, you can set sales targets that actually reflect your life. You'll learn how to list every fixed and variable expense, divide it into a weekly figure, and build sales output above it so you're earning, not just surviving.",
        "what_good_looks_like": [
            "Calculates a precise personal weekly breakeven",
            "Lists every fixed and variable expense — no rounding",
            "Sets sales targets above breakeven, not at it",
            "Reviews actuals vs. breakeven each week",
            "Adjusts spending or output when the gap closes",
        ],
        "leader_coaching_notes": [
            "Walk through the calculation together on paper",
            "Push for honest expense numbers — many new BAs lowball",
            "Tie sales targets back to breakeven each Monday huddle",
            "Reinforce that breakeven is a floor, never the goal",
        ],
    },
    "Understanding Independence": {
        "trainee_content": "Independence is what separates the average BA from the BA who builds a career. You'll learn what autonomy and ownership actually mean in this role: managing your time, making sound decisions, and owning your results without being told. Nobody reaches Stage 3 by waiting for instructions — people advance because they don't need them.",
        "what_good_looks_like": [
            "Manages own schedule and territory without prompting",
            "Takes initiative to solve problems before escalating",
            "Owns their numbers — good or bad — without excuses",
            "Makes sound decisions with limited guidance",
            "Works proactively towards weekly and monthly goals",
        ],
        "leader_coaching_notes": [
            "Define exactly where their autonomy starts and ends",
            "Give them controlled chances to decide and recover",
            "Step back gradually — don't jump in to rescue",
            "Celebrate independent wins louder than rescued ones",
        ],
    },
    # NOTE: an orphan "Example Setting How/Why" key used to live here — it
    # matched no seed topic (the real topics are "Example Setting — How?" /
    # "Example Setting — Why?" below) and was removed in the 2026-08 audit.
    "Example Setting — How?": {
        "trainee_content": "Example setting is HOW you show up: dress, posture, tone, time-keeping, and attitude in the field. You'll learn the practical behaviours that signal leadership before any title arrives — knocking with energy, walking with purpose, talking to the team with respect even on a flat day. Every action is either reinforcing the standard or eroding it.",
        "what_good_looks_like": [
            "Dresses, walks, and speaks like the leader they want to be",
            "Knocks with the same energy at door 1 and door 100",
            "Stays composed and professional in front of the team during pressure",
            "Arrives on time and ready every single day",
            "Holds their own standard publicly so the team copies it",
        ],
        "leader_coaching_notes": [
            "Audit your own day-one behaviours — they are watching everything",
            "Pick three concrete behaviours and over-deliver on them publicly",
            "Catch slippage in yourself fast and self-correct in front of the team",
            "Ask trusted peers what example you're actually setting today",
        ],
    },
    "Example Setting — Why?": {
        "trainee_content": "Example setting is WHY leadership is earned, not assigned. You'll learn that people don't follow what you say — they follow what you consistently do. Modelling the right behaviours builds trust, accelerates the team's standards, and gives you the moral authority to coach others hard. Without example, every speech you give is air.",
        "what_good_looks_like": [
            "Articulates why example setting earns the right to coach",
            "Connects personal behaviour to team culture and results",
            "Owns it when their behaviour falls short of the standard",
            "Speaks about leadership in terms of actions, not titles",
            "Uses their own example to inspire the team without bragging",
        ],
        "leader_coaching_notes": [
            "Explain the link between example, trust, and authority",
            "Share a personal story where your example shifted a teammate",
            "Help them internalise that culture is set by repeated behaviour",
            "Reinforce that the team mirrors the leader within 30 days",
        ],
    },
    "Assuming the Role": {
        "trainee_content": "Assuming the role means dressing it, walking it, and thinking it before the title is official. You'll learn that leadership presence isn't an advancement you wait for — it's a posture you adopt now. Take ownership of team responsibilities, communicate expectations clearly, and act like the leader you intend to become long before the badge says so.",
        "what_good_looks_like": [
            "Takes ownership of team responsibilities, not just their own",
            "Carries leadership presence in dress, posture, and voice",
            "Engages actively in team development conversations",
            "Communicates expectations clearly and confidently",
            "Acts like the leader they want to become — daily",
        ],
        "leader_coaching_notes": [
            "Be explicit about what 'assuming the role' looks like at your office",
            "Give them micro-leadership reps (lead a meeting, mentor a starter)",
            "Critique their leadership presence directly and kindly",
            "Reinforce that the title follows the behaviour, not the other way around",
        ],
    },
    "Know Your Critical Numbers": {
        "trainee_content": "If you can't measure it, you can't move it. Your critical numbers are the small handful of metrics that drive everything else: doors knocked, presentations given, sign-ups made, conversion rate. Knowing yours by heart turns guesswork into strategy. Every successful leader in this business can recite their numbers cold — make sure you can too.",
        "what_good_looks_like": [
            "Identifies their personal critical numbers without help",
            "Tracks them daily with no gaps",
            "Spots trends and acts on them quickly",
            "Uses data to set the next day's plan",
            "Sets goals based on real numbers, not vibes",
        ],
        "leader_coaching_notes": [
            "Make critical numbers visible (whiteboard, group chat)",
            "Provide a simple tracking template they can copy",
            "Coach interpretation, not just recording",
            "Review numbers in 1-on-1s every week without fail",
        ],
    },
    "Know Your Why": {
        "trainee_content": "Your 'why' is the reason you keep going when the day fights back. You'll learn how to surface what actually drives you — beyond the earnings — and connect that to your daily work. The strongest leaders in our company can name their why in one sentence, and it shows up in their resilience, focus, and ability to lift others when motivation wavers.",
        "what_good_looks_like": [
            "Articulates a personal 'why' in one clear sentence",
            "Connects their why to their goals and daily work",
            "Stays resilient in the face of obstacles",
            "Keeps focus on long-term objectives, not just today",
            "Uses their why to inspire teammates",
        ],
        "leader_coaching_notes": [
            "Run reflective exercises to help them surface their real why",
            "Encourage them to share their why with the team",
            "Tie team vision back to individual whys at meetings",
            "Bring them back to their why on hard days — out loud",
        ],
    },
    "Creating Your Own Network": {
        "trainee_content": "A strong professional network is one of the most undervalued assets in this business. You'll learn the value of building real connections — with teammates, mentors, supporters, and industry contacts — and how to nurture them over time. The network you build now becomes the recruiting pipeline, support system, and opportunity engine of the leader you become later.",
        "what_good_looks_like": [
            "Actively seeks networking opportunities at every event",
            "Builds genuine, give-first connections",
            "Stays in touch with contacts long after the first meeting",
            "Leverages the network when seeking help or advice",
            "Offers value to their network without being asked",
        ],
        "leader_coaching_notes": [
            "Explain the long-term ROI of relationships in this business",
            "Encourage attendance at company events and outside meetups",
            "Make warm introductions to key people in the org",
            "Coach on follow-up systems (CRM, calendar reminders)",
        ],
    },
    "Taking Initiative": {
        "trainee_content": "Initiative means seeing what needs doing and doing it before someone asks. You'll learn that proactive behaviour — solving problems, sharing ideas, owning new responsibilities — is what gets noticed and rewarded. Reactive people stay where they are; people who take initiative get pulled forward. Find the gaps and fill them.",
        "what_good_looks_like": [
            "Spots opportunities and problems without being told",
            "Takes ownership of tasks and projects voluntarily",
            "Proactively offers solutions, not just complaints",
            "Contributes ideas in meetings and 1-on-1s",
            "Demonstrates a proactive, get-it-done work ethic",
        ],
        "leader_coaching_notes": [
            "Encourage them to flag improvements they notice",
            "Hand them a small project they can fully own",
            "Reward initiative publicly so the rest of the team copies it",
            "Be patient when their initiative misfires — coach, don't punish",
        ],
    },
    "Working Different Territories": {
        "trainee_content": "Not every territory looks the same — and your approach has to flex with the demographics, density, and rhythm of each one. You'll learn how to read a new area, adapt your opener and pace, and bring lessons from one map to the next. Versatility is what makes you ready to advance: leaders run multiple territories, and their BAs need to as well.",
        "what_good_looks_like": [
            "Adapts approach and pace to a new territory's profile",
            "Reads local signals (housing, signs, traffic) quickly",
            "Builds rapport with diverse supporter types",
            "Manages time and travel efficiently across areas",
            "Carries lessons from one territory to the next",
        ],
        "leader_coaching_notes": [
            "Brief them on each territory's quirks before they walk it",
            "Coach on tweaking opener and tone per area, not script",
            "Pair them with experienced BAs in unfamiliar territories",
            "Debrief at the end of the day on what was different",
        ],
    },
    "Solving Problems": {
        "trainee_content": "Problem-solving is a muscle you'll use every single day in this business. You'll learn how to identify the real issue (not just the symptom), analyse the root cause, develop options, and pick the best one to act on. The BAs who advance are the ones who solve at their level — they don't escalate every wrinkle to their coach.",
        "what_good_looks_like": [
            "Identifies the actual problem, not just the symptom",
            "Diagnoses root cause before jumping to solutions",
            "Generates multiple options before picking one",
            "Implements the chosen solution cleanly",
            "Reviews the outcome and learns from it",
        ],
        "leader_coaching_notes": [
            "Hand them realistic problems — don't solve them yourself",
            "Walk through a clear problem-solving framework (define → analyse → solve → review)",
            "Encourage divergent thinking before converging on a fix",
            "Critique the process, not just the answer",
        ],
    },
}


# ─── Stage 3 — Leadership ─────────────────────────────────────────────────
# Stage 3 content is now authored DIRECTLY in core/module_seed.py
# (STAGE_3_MODULES) — that's the single source of truth. We keep an
# empty enrichment dict here so the seed pipeline doesn't accidentally
# overwrite the rich seed content with a stale stub.

STAGE_3_CONTENT: Dict[str, ModuleEnrichment] = {
    "Self-Motivation": {
        "trainee_content": "Self-motivation is what drives you when no one is watching. You'll cultivate the internal engine and consistent work ethic that sustain a leader through months and years, not just good weeks. Effective leaders are self-starters — they push themselves without external direction, demonstrate resilience under pressure, and stay committed to growth even when results lag.",
        "what_good_looks_like": [
            "Sets and pursues personal goals through dry spells",
            "Maintains enthusiasm across long projects, not just sprints",
            "Proactively seeks self-improvement and skill upgrades",
            "Stays productive regardless of external noise",
            "Responds to setbacks with determination and a focus on solutions",
        ],
        "leader_coaching_notes": [
            "Help them define their 'why' beyond the earnings — make it real",
            "Build a personal development plan with measurable milestones",
            "Identify obstacles ahead of time and pre-plan responses",
            "Check in regularly — acknowledge effort, critique self-management",
        ],
    },
    "Accountability": {
        "trainee_content": "Accountability is owning your outcomes — and creating an environment where your team owns theirs. You'll learn the difference between blame and accountability, how to set crystal-clear expectations, and how to hold people to those commitments without nagging or hovering. Empowered teams need leaders who hold the bar without lowering it.",
        "what_good_looks_like": [
            "Owns mistakes openly and learns from them",
            "Sets clear expectations and consequences upfront",
            "Holds the team accountable in a supportive, non-confrontational way",
            "Reviews team performance proactively, not reactively",
            "Builds a culture where ownership is the default",
        ],
        "leader_coaching_notes": [
            "Coach on the line between blame and accountability",
            "Practise setting expectations with concrete language",
            "Roleplay accountability conversations — make them constructive, not punitive",
            "Encourage data-backed conversations: numbers don't argue back",
        ],
    },
    "Understanding the Pipeline": {
        "trainee_content": "Your recruiting pipeline is the lifeline of your team. You'll learn how to source, qualify, and engage potential team members, and nurture relationships so the right talent shows up when you need it. A strong pipeline isn't built when you need someone — it's built constantly so you never need to scramble.",
        "what_good_looks_like": [
            "Proactively identifies recruits across multiple channels",
            "Communicates the opportunity with clarity and conviction",
            "Maintains relationships with candidates over time",
            "Articulates the recruitment process step by step",
            "Consistently grows the pipeline week over week",
        ],
        "leader_coaching_notes": [
            "Walk through different sourcing strategies (referrals, events, online)",
            "Coach on crafting compelling messages for talent",
            "Build a follow-up system so leads don't go cold",
            "Review their pipeline weekly with the same rigour as sales numbers",
        ],
    },
    "First Day Coaching Plan": {
        "trainee_content": "A new starter's first day sets the tone for their entire run. You'll learn how to plan a structured, supportive day-one experience that introduces processes, builds confidence, and signals 'we take you seriously.' A strong first day creates retention; a weak one creates a quitter you didn't see coming.",
        "what_good_looks_like": [
            "Has a written, detailed plan for every new starter's day one",
            "Walks the new starter through the day's flow upfront",
            "Conducts intro meetings and explains essential processes clearly",
            "Models desired behaviours and coaches the core open",
            "Ensures the new starter leaves day one informed and excited",
        ],
        "leader_coaching_notes": [
            "Review their day-one plan before the new starter shows up",
            "Coach on making the new starter feel welcomed and engaged",
            "Watch them deliver the plan and give feedback",
            "Solicit the new starter's perspective — what could be tighter?",
        ],
    },
    "Creating Independence": {
        "trainee_content": "Your role as a leader is to make yourself unnecessary on the day-to-day. You'll learn how to develop your team to be self-sufficient — providing skills, knowledge, and confidence so they can perform without constant guidance. The goal: empower them to make decisions, solve problems, and drive their own success, freeing you to lead at the next level up.",
        "what_good_looks_like": [
            "Reduces hands-on guidance as proficiency grows",
            "Empowers team members to make real decisions",
            "Creates opportunities for others to lead initiatives",
            "Gives feedback that drives self-correction, not dependency",
            "Celebrates independent problem-solving publicly",
        ],
        "leader_coaching_notes": [
            "Coach on assessing readiness for more autonomy",
            "Practise clean delegation — clear context, clear ownership",
            "Build moments where the team has to step up without you",
            "Encourage trust before perfection",
        ],
    },
    "Map Management": {
        "trainee_content": "Strong leaders run their map like a portfolio. You'll learn to plan territories, optimise routes, prioritise the highest-leverage areas, and ensure every hour spent in the field is producing. Efficient map management is the difference between burning the team out and compounding their output across the same time and energy.",
        "what_good_looks_like": [
            "Plans logical, efficient coverage across territories",
            "Prioritises high-potential areas and supporters",
            "Adapts the plan when conditions change",
            "Understands supporter density and travel-time maths",
            "Uses mapping tools and data to guide decisions",
        ],
        "leader_coaching_notes": [
            "Review territory maps with them — find optimisation gaps",
            "Coach on prioritisation: what comes first and why",
            "Show how to adapt plans to live feedback",
            "Encourage them to share best-practice routes with peers",
        ],
    },
    "Self-Awareness": {
        "trainee_content": "Self-awareness is the foundation of every other leadership skill. You'll cultivate a deep understanding of your own emotional intelligence, strengths, blind spots, and leadership style. Recognising how you actually impact others — versus how you think you do — lets you adapt your approach, build stronger relationships, and avoid the traps that derail talented people.",
        "what_good_looks_like": [
            "Actively seeks feedback on their leadership and behaviour",
            "Recognises emotional triggers and manages them in the moment",
            "Identifies blind spots and works on them deliberately",
            "Adapts communication style to individual team members",
            "Reflects regularly on performance and growth areas",
        ],
        "leader_coaching_notes": [
            "Encourage solicited feedback from peers and the people they coach",
            "Discuss their self-perceived vs. actual leadership style",
            "Help them spot blind spots they keep missing",
            "Make reflection a recurring habit, not a one-off exercise",
        ],
    },
}


def get_enrichment(stage: int, topic: str) -> ModuleEnrichment | None:
    """Look up enrichment for a (stage, topic) pair, or return None if missing.
    Topic match is case-insensitive on first 30 chars to tolerate small drift."""
    src = STAGE_2_CONTENT if stage == 2 else STAGE_3_CONTENT if stage == 3 else {}
    # Exact match first
    if topic in src:
        return src[topic]
    # Loose match — strip punctuation, lowercase, take prefix
    norm = topic.lower().replace("'", "").replace("—", "").strip()
    for k, v in src.items():
        kn = k.lower().replace("'", "").replace("—", "").strip()
        if norm.startswith(kn[:25]) or kn.startswith(norm[:25]):
            return v
    return None
