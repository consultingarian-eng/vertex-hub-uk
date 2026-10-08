# Vertex Hub UK — the field app for door-to-door fundraising offices

The UK edition of **CG1**, the field app Cube Group USA runs its offices on, rebuilt by **Vertex Labs** for UK door-to-door **fundraising** offices: self-employed Brand Ambassadors (BAs) signing up regular givers by Direct Debit, coaches who develop them, and the owner who runs the office. British English, £ and UK time throughout, and self-employed language only.

Clone it, open it in Claude Code, and in an afternoon you'll have your own copy running on your own database and domain, in your own branding, connected to your OwnerIQ.

**See it:** a guided tour of CG1 and this UK edition is on the showcase site: **[tech-stack.cubemarketing.us/#/cg1](https://tech-stack.cubemarketing.us/#/cg1)**.

## What's inside

**Getting around**
- A sidebar on desktop and tablets, with **top tabs** so several screens stay open side by side; a tab bar on phones. Everyone can choose and order their own sidebar (**Customise**).
- Installs to the home screen on iPhone and Android from one link (`/launch`), with push notifications, an **Inbox** of every notification, light and dark themes, and an **Update ready** prompt after each deploy.

**New BAs**
- **Start Here** onboarding, then **BA Academy** and the first days on badge: eight graded days with daily checklists and targets, and a **My Progress** journey.
- Coaches grade each day's skills; orientation can be graded for a whole class at once.

**Development: the COD**
- The **Cycle of Development**: Stages 1–4 and Sector Leader, with learning modules, self-checks, AI quick quizzes and coach sign-off. **COD Vetting** lets the owner review and edit every module.
- **Coaching**: a coaching hub with impacts and a library, an AI **coaching assistant** that answers from your own material, and AI **reports** on a person.
- Optional **Sales Development Path**: levels, Green Weeks and a ramp for new BAs.

**Performance**
- **Performance Hub**: the week's office figures the way OwnerIQ lays them out (sales, piece average, scoring, reliability, BAs in the field…), teams and every BA, tile by tile and day by day. Coaches see their own team; Admins and **Coach+** see the whole office.
- **Timeline**: sign-ups hour by hour, an average field day (first door, last door, sector break) and best, average and low week patterns.
- **Spider** diagram: the team as rings of generations around you, with OwnerIQ stages, rank counts, and drag-to-move for admins.
- **Live Operations**: today's sectors in the field, each BA's running totals and door-by-door log.
- **Field KPIs**: doors, spoken to, presented, closed and sign-ups, with averages and ratios to one sign-up.
- **Bells**: the weekly sign-ups board, laid out like an office spreadsheet (a section per team, goals, BAs in and scoring), filled from OwnerIQ or a pasted WhatsApp report, with a public share link, weekly **bulletin** posters and a daily breakdown.
- A "two zeroes in a row" alert to the owner and the coaches above a BA who needs a retrain.

**Earnings and planning**
- **Earnings Calculator**: this week's estimated earnings, the quality-payments projection, and the office's **Rates** (editable per office). Ships with Vertex's pay plan: per-sign-up fees by donation level, call-completion and donor-age conditions, weekly and monthly incentives, and quality payments.
- **Schedule**: the office week as a calendar, with a locked office timetable, personal events and reminders, and photo-scan of a printed schedule.
- Weekly and monthly goal **planners**, an AI planner coach, **Primetime** planning, absences and a Monday review.

**Running the office**
- **Admin**: offices, people, coaches and reporting lines, **Coach+** and badge numbers.
- **ID Badges**: Badge Studio prints each BA's ID badge (photo, name, ID, expiry, your organisation, a verification number and a QR code) on a neutral template or your own approved artwork, with optional photo background removal.
- **Manual**: the training manual, daily targets and modules, editable in the app (and from a password-protected editor page you can share).
- **Campaign Knowledge**: the playbook, from the pitch and solicitation statement to quality and the terminology guide.
- **Quality**: the charity's monthly quality report, per BA, with its RAG bands.
- Achievements and team-week badges, the Home dashboard with live field cards, and **New Starts** for the whole office.

**OwnerIQ**
- Hourly sync of field KPIs, the Performance Hub, Bells goals and sign-ups; live Live Operations; a nightly re-settle; an optional two-way people sync. Read-only until you switch writes on. See [docs/OWNERIQ.md](docs/OWNERIQ.md).

## Words you'll see in the app

| Word | What it means here |
| --- | --- |
| **BA** | Brand Ambassador: a self-employed fundraiser in the field (role `trainee` in the code) |
| **Coach**, **Coach+** | A Coach develops a team of BAs and sees that team. **Coach+** is a switch on a Coach (Admin → Users) that lets them see the whole office and use Badges |
| **Admin**, **Owner** | An Admin runs an office. The Owner is the super-admin who sees every office |
| **Sign-up** | One regular giver signed up in the field. It is what Bells, targets and Earnings count |
| **Direct Debit** | How the giver pays the charity. The charity's monthly quality report shows how many sign-ups went on to complete |
| **Close** | The ask: the point in the pitch where the BA asks for the sign-up (not the same as a sign-up) |
| **Rehash** | The step after the ask that makes the commitment stick |
| **Sector** | An area worked by a team on a day; Live Operations is organised by sector |
| **Bells** | The weekly sign-ups board, laid out like an office spreadsheet, per team and per day |
| **COD** | Cycle of Development: Stages 1–4 and Sector Leader, with modules and coach sign-off |
| **Green Week** | A BA's week of 8 or more sign-ups (10 or more is a Super Green Week) |
| **Primetime** | The daily coaching slot in the office schedule, planned as Learning, Teaching or Watching |
| **RAG bands** | Red / amber / green colours on the Quality screen, following the charity's own report thresholds |
| **Performance Hub** | The week's office figures from OwnerIQ, tile by tile and day by day |
| **Live Operations** | Today's sectors in the field with each BA's running totals and door log |
| **Spider** | The diagram of the team as rings of generations around you, with OwnerIQ stages |
| **LOA** | Law of Averages: what it takes, on average, to land 1 sign-up (shown on Home and in the team Planner review) |
| **PAFB** | Pre Allocated Fundraising Budget: the charity's budget that pays for professional fundraisers (explained in the training) |
| **New Starts** | New BAs in their first days, followed by the whole office |

## Build your own with Claude Code

1. **Get the tools:** Git, Python 3.11 or newer (3.13 works), Node.js LTS and [Claude Code](https://code.claude.com/docs/en/setup) ([docs/SETUP.md](docs/SETUP.md), step 1).
2. **Clone it and make it yours:**

   ```
   git clone https://github.com/consultingarian-eng/vertex-hub-uk.git my-field-app
   cd my-field-app
   claude
   ```

   Keep your own copy in a **private** repository (step 2 of the manual shows how in three commands).

3. In Claude Code, run:

   | Command | What it does |
   | --- | --- |
   | `/setup` | Walks you through the database, settings, Railway and your domain, one step at a time, and checks each one |
   | `/brand` | Puts in your name, logo, icons, colours and badge template, then shows you the result |
   | `/connect-owneriq` | Connects your OwnerIQ with a read-only check first, and explains what will sync |

You can stop at any point; run the command again and it picks up where you left off.

## What you'll need

| Service | Needed? | For |
| --- | --- | --- |
| GitHub | Required | Your private copy of the code |
| MongoDB Atlas | Required | The database (has a free tier to start) |
| Railway | Required | Hosting (or any host that builds a Dockerfile) |
| Claude Code | Recommended | Setting up and changing the app without being a developer |
| A domain | Recommended | `app.yourdomain.co.uk` |
| SendGrid | Optional, recommended | Welcome and password-reset emails |
| Web push keys | Optional, recommended | Phone notifications (free; generated with one command) |
| OwnerIQ owner login | Optional | Field numbers, Live Operations, Performance Hub, Timeline |
| Anthropic API key | Optional | The AI features |
| Cloudflare R2 / S3 | Optional | Photo storage |
| Replicate | Optional | Badge-photo background removal |

Everything optional stays switched off until you add its settings. Details and pricing links: [docs/SERVICES.md](docs/SERVICES.md).

## How it's built

```
Phones / browsers ──► one Railway service (Docker)
                        ├─ the web app: Expo Router (React Native), exported as a static web app
                        └─ the server: Python 3.11 or newer, FastAPI, scheduled jobs (APScheduler)
                               ├─► MongoDB (Atlas)
                               └─► OwnerIQ · SendGrid · Anthropic · web push · S3/R2 · Replicate
```

- **Frontend** (`frontend/`): Expo Router, React Native for web, TypeScript. Screens in `frontend/app/`, shared code in `frontend/src/`. Ships as an installable web app; native builds are possible but not set up ([frontend/README.md](frontend/README.md)).
- **Backend** (`backend/`): FastAPI with Motor (MongoDB). Entry point `backend/server.py`; API routes in `backend/routes/` (all under `/api`); shared logic in `backend/core/`; OwnerIQ in `backend/owneriq_*.py`; starting content in `backend/seed/`.
- **Deploy**: the root `Dockerfile` builds the web app with Node 20, then serves it from the Python image; `railway.toml` sets the `/health` check. GitHub Actions (`.github/workflows/ci.yml`) runs the tests, type check and web build on every push.
- **Time**: every "today", week and scheduled job runs on UK time (`APP_TIMEZONE`, default `Europe/London`), never the server clock.

## Documentation

| Guide | For |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | Full setup: tools, database, settings, local run, Railway, domain, first login, phones, troubleshooting |
| [docs/OWNERIQ.md](docs/OWNERIQ.md) | Connecting OwnerIQ: settings, what syncs when, write-back, errors |
| [docs/BRANDING.md](docs/BRANDING.md) | Your name, logos, icons, colours, fonts, badge template, with a checklist |
| [docs/SERVICES.md](docs/SERVICES.md) | Every outside service: what it powers, what breaks without it |
| [backend/.env.example](backend/.env.example) | Every setting, commented |
| [CLAUDE.md](CLAUDE.md) | House rules and a code map for Claude Code |

## Credits

- **CG1** by **Cube Group USA**: the original field app.
- **UK edition** by **Vertex Labs**: rebuilt for UK door-to-door fundraising, with its training, campaign material and pay plan.

The training and campaign content was written for one campaign: the **National Deaf Children's Society (NDCS)**, run through the fundraising agency **Acwyre**. That is what the seed files say, word for word. If you work for a different charity or agency, replace it before your team sees it: change the starting files in `backend/seed/` before the first start of a new database, or on a live app edit it in the screens (Manual, Campaign Knowledge, COD Vetting, Earnings → Rates). [docs/SETUP.md](docs/SETUP.md#step-11--make-it-yours) explains which to use. Never present another charity's facts, wording or artwork as your own.

## License

[MIT](LICENSE) — Copyright (c) 2026 Cube Group USA and Vertex Labs.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md). Never open a public issue for a security problem.

This repository contains no secrets. Every key, password and connection string is yours to set on your own host; see [backend/.env.example](backend/.env.example).
