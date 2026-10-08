# Notes for Claude Code

This repo is the **UK edition of CG1**: a field app for UK door-to-door **fundraising** offices. Self-employed Brand Ambassadors (BAs) sign up regular givers by Direct Debit; Coaches develop them; the Owner runs the office. CG1 is by Cube Group USA; this UK edition is by Vertex Labs. The person you're working with is an office owner running **their own copy**, often new to development. Teach as you go, one step at a time, and check each step worked.

Backend: FastAPI + MongoDB (Motor) in `backend/`. Frontend: Expo Router (React Native, shipped as an installable web app) in `frontend/`. Railway builds both from the root `Dockerfile` and deploys every push to `main`. The repo's default branch is `main`.

## Skills: use them

| Ask | Skill |
| --- | --- |
| Set up, install, host, deploy, go live, connect a database or domain, turn on email/notifications/AI, "what's next?" | `/setup` (`.claude/skills/setup/SKILL.md`, follows `docs/SETUP.md`) |
| Rebrand: name, logo, icons, colours, fonts, badge template | `/brand` (`.claude/skills/brand/SKILL.md`, follows `docs/BRANDING.md`) |
| Connect OwnerIQ, OwnerIQ numbers missing, people unlinked, turning on OwnerIQ writes | `/connect-owneriq` (`.claude/skills/connect-owneriq/SKILL.md`, follows `docs/OWNERIQ.md`) |

The docs in `docs/` are the source of truth for those tasks. If code and docs disagree, trust the code, tell the owner, and fix the doc.

## Safety rules (always)

- **Secrets never leave their place.** Real values live only in the host's variables (Railway → Variables) and in a local `backend/.env` / `frontend/.env`, which git ignores. Never commit a `.env` file: run `git status` before every commit and check none appears. Never write a real value into a tracked file, a doc, a test, a commit message or an issue.
- **Never print a secret.** When you must refer to one, show at most its first 4 characters. Don't `cat` `.env` files or run `railway variables` into the conversation; check that a variable is *set*, not what it is. Secrets include `MONGO_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`, `SENDGRID_API_KEY`, `OWNERIQ_PASSWORD`, `ANTHROPIC_API_KEY`, `VAPID_PRIVATE_KEY`, `CI_S3_SECRET_ACCESS_KEY`, `REPLICATE_API_TOKEN`, `ROSTER_SHARE_TOKEN`, `MANUAL_EDITOR_PASSWORD`.
- **OwnerIQ writes stay off until the owner says so.** Don't set `OWNERIQ_WRITES_ENABLED`, and don't call `/api/owneriq/rep-action` without `dry_run`, `/api/owneriq/reconcile?dry_run=false`, or anything in `backend/owneriq_write.py` for real, unless the owner has explicitly asked in this conversation. Dry runs are fine.
- **Local runs never touch production.** Locally use a separate database (`DB_NAME=<name>_dev`) and leave SendGrid, OwnerIQ and VAPID keys out of `backend/.env`. A local server starts the same scheduled jobs as production (pushes, nudges, OwnerIQ sync): pointed at the live database it would message the team.
- **Ask before anything that sends, deletes or costs money**: emails, pushes, deploys, database writes on the live database, deleting data, upgrading a paid plan.
- **Public repo hygiene.** Never add real people's names, emails, phone numbers or addresses to code, seed data, tests or docs. Use obvious placeholders (`Example Person`, `you@example.org`).

## House rules for anything users read

- **British English, £, UK time.** Dates in UK order (30 Sep 2026, 30/09/2026), 24-hour times. Money through `formatMoney()` / `APP_CURRENCY` in `frontend/src/utils/appTime.ts`. Every "today" and week boundary reads the app time zone: `APP_TZ` in `backend/core/app_time.py` and `frontend/src/utils/appTime.ts` (env `APP_TIMEZONE`, default `Europe/London`). Never hard-code a time zone or `en-US`.
- **Self-employed language only.** Nobody is employed. Follow the Terminology topic in Campaign Knowledge (`backend/seed/product_knowledge_topics.json`, slug `terminology`): no hire/job/employ/salary/wages/bonus/manager/boss/promotion/fire/duties/pay slip. Say recruit/appoint, opportunity/role, earnings/fees, incentives, the Owner, coach/mentor, advancement, release from contract, responsibilities, BA Fee Invoice. AI prompts get this from the shared rules in `backend/core/brand.py` (`BRITISH_ENGLISH`, `SELF_EMPLOYED_TERMS`).
- **The playbook is quoted, not rewritten.** Campaign Knowledge and the training content (pitch, solicitation statement, Gift Aid line, welcome call wording, who not to sign up, thank-yous, donor profiles, what good looks like) are used word for word. Don't reword them unless the owner asks, and never invent charity facts or figures.
- **Defined terms stay exact:** Close (the ask), Rehash, Primetime, Bells, Sector, COD, BA, and the stage and level names. Role values in code and data stay `trainee` / `leader` / `admin`; on screen they read BA / Coach / Admin (`role_label()` in `backend/core/brand.py`).
- **Brand comes from one place each side.** Names: `APP_NAME` / `ORG_NAME` (backend `core/brand.py`, from env) and `frontend/src/theme/brand.ts`. Colours: `brand` and the gradients in `frontend/src/theme/brand.ts`, read through `useColors()`. Don't add new hard-coded names or hex colours. Text on the accent colour uses `colors.onPrimary` / `onAccent`.

## Security rules for code changes

- **Ids authorise, names don't.** Display names can be changed by their owner, so never grant access because a name matches: use `owneriq_user_id` / badge links, `trainee_user_id`, `leader_user_id`, `reports_to`. Names are for display and suggested links only.
- **Office admins stay in their office.** A route that takes another record's id checks its `office_id` against the caller's unless the caller is the super-admin (see `_guard_subject` in `backend/routes/reports.py`, `_guard_rep_target` in `backend/routes/owneriq.py`).
- **One model setting.** Never write a model id in a call site: `LlmChat(...).with_model("anthropic")` (or `"vision"` for photo reading) and the id comes from `ANTHROPIC_MODEL` (`backend/emergentintegrations/llm/chat.py`). Every AI route calls `take_ai_quota(user)` (`backend/core/rate_limit.py`).
- **One database handle.** Import `db` from `backend/database.py`; never open another Mongo client.
- **Client IPs come from `client_ip()`** in `backend/core/rate_limit.py`, never straight from `X-Forwarded-For`.
- More in [SECURITY.md](SECURITY.md#rules-the-code-keeps-for-contributors). `backend/tests/test_hardening_unit.py` pins these rules.

## Code map

| Path | What |
| --- | --- |
| `backend/server.py` | App bootstrap, middleware, `/health`, `/api/version`, and **every scheduled job** (search `scheduler.add_job`) |
| `backend/auth.py` | Sessions (JWT cookies), roles, `is_coach_plus` / `sees_whole_office` / `can_use_badges` |
| `backend/routes/` | API endpoints, all under `/api` (public pages `/launch`, `/public/…` mount at the root) |
| `backend/core/` | Shared logic: `bootstrap.py` (admin + first office seed), `brand.py`, `app_time.py`, `email_utils.py`, `push.py` / `webpush.py`, `vertex_pay.py`, `zero_alerts.py`, `content_fixes.py`, `module_seed.py`, `object_storage.py` / `media_store.py` |
| `backend/owneriq_*.py` | OwnerIQ: `sync` (KPIs), `config` (companies/offices), `performance` (hub sync, Bells fill, linking), `hub`, `live`, `field` (Timeline), `write` (all writes + people sync) |
| `backend/seed/`, `seed_data.py`, `seed_loader.py` | Starting content for a new database |
| `backend/emergentintegrations/` | Small vendored wrapper around the Anthropic SDK (`LlmChat`) |
| `backend/tests/` | Backend unit tests (in-memory Mongo; nothing needs to be running) |
| `frontend/app/` | Screens (file-based routes). `(tabs)/` holds Home, Performance Hub (`hires.tsx`), Schedule, COD (`progress.tsx`), Earnings (`pay.tsx`), Manual, Admin, Profile |
| `frontend/src/` | API client (`api/client.ts`), theme (`theme/`), nav (`nav/`, `customization/tabRegistry.ts`), components, hooks, utils |
| `frontend/public/` | PWA manifest, service worker (`sw.js`), icons |
| `tests/` | Repo-level tests (app config, office scoping) |
| `docs/` | Owner guides: SETUP, OWNERIQ, BRANDING, SERVICES |

## Business rules worth knowing

- **Earnings** (as shipped: Vertex's pay plan; every number is editable per office in **Earnings Calculator → Rates**): a fee per sign-up by donation level, a reduction in weeks with low call completion, weekly and monthly incentives with donor-age and call-completion conditions, and quality payments paid some months after the sign-up month. Formulas: `frontend/src/pay/vertexPay.ts`, mirrored on the server in `backend/core/vertex_pay.py` (used by Bells). Change both together.
- **Who sees what:** Coach+ is a flag on a Coach (`users.coach_plus`; role stays `leader`), set per person in Admin. Admins and Coach+ see the whole office in Live Operations, the Performance Hub and Field KPIs, and are the only ones who can use Badges. A Coach sees their own team (their OwnerIQ team plus teams led by people under them). The server decides (`backend/auth.py`); screens mirror it with `seesWholeOffice` in `frontend/src/utils/roleTitle.ts`.
- **Bells fields:** `under30` = £12 sign-ups, `over30` = £15+ sign-ups, `memberships` = unused legacy (hidden). The names are historical; keep them. People not in a named team form the team "Mini <APP_SHORT_NAME>" (its goal lives in `bells_group_goals`). **MC fees** (`fee_mc`) is Admin-only and never sent to anyone else. A goal typed in the app is marked `weekly_goal_source: "app"` and the OwnerIQ sync leaves it alone.
- **Day targets** live in `backend/seed_data.py` for new offices and in **Manual → KPIs** once live.
- **Timeline** reads only `owneriq_field_days` (built by `backend/owneriq_field.py` from door logs in `owneriq_live_cache`; sums in `backend/core/field_days.py`).
- **Two zeroes in a row** (`backend/core/zero_alerts.py`): a zero is a Bells day `in` with no sign-ups; two most recent days in both zero → one "Retrain needed" alert to the Owner and the Coaches above. Today only counts from 21:00 UK time.

## Content: seed files vs the live database

`backend/seed/*.json`, `backend/seed_data.py` and `backend/core/module_seed.py` only fill a **new** database. Seeding is additive and never overwrites. Once an office is live, content is edited in the app (Manual, COD Vetting, Rates, Schedule). Changing a seed file does nothing to an existing database unless you also write a startup fix: see `backend/core/content_fixes.py` for the pattern (heal only documents whose text still exactly matches the old version).

## Run, test, build

Local run (two terminals; `docs/SETUP.md` step 5 has the full version):

```
cd backend && source venv/bin/activate && uvicorn server:app --reload --port 8000
cd frontend && npx expo start --web --port 8081      # frontend/.env: EXPO_PUBLIC_BACKEND_URL=http://localhost:8000
```

Checks (CI runs the same; run them before every push):

```
cd backend && JWT_SECRET=local-dummy-secret-0123456789abcdef0123456789 MONGO_URL=mongodb://localhost:27017 python -m pytest tests -q
python -m pytest tests -q                                   # repo root, same two variables
cd frontend && npx tsc --noEmit
cd frontend && EXPO_PUBLIC_BACKEND_URL="" npx expo export --platform web
```

Import smoke test: `cd backend && python -c "import server"` with the same two variables. Deploy = push to `main`; Railway builds the `Dockerfile`.

## Frontend gotchas

- It runs as an installed iPhone/Android web app. `KeyboardAvoidingView` does nothing on web; use `useKeyboardInset()` / `useWebViewportPin()` in `src/hooks/useKeyboardInset.ts` for sheets with text inputs.
- **Never make a navigator scene or screen background transparent.** On web the new screen draws over the old one.
- Verify navigation changes by tapping through the app, not only by loading URLs: a URL load has no previous screen underneath, so it hides stacking bugs.
- The tab bar overlays content: screens use `useTabBarClearance()` for bottom padding.
- Custom fonts on web: never add `fontWeight` to a registered font family (it fakes a bold).
