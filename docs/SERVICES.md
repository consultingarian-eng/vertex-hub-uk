# Third-party services

Every outside service the app can use: what it powers, whether you need it, what happens without it, and which settings it reads. Only three are needed to go live: **GitHub**, **MongoDB Atlas** and **Railway**. Add the rest one at a time, in any order.

Prices change, so this page doesn't quote any. Check each provider's pricing page before you sign up, and set spending limits where the provider offers them.

## At a glance

| Service | Needed? | Powers | Settings |
| --- | --- | --- | --- |
| [GitHub](#github) | Required | Holds your copy of the code; runs the checks | none |
| [MongoDB Atlas](#mongodb-atlas) | Required | The database | `MONGO_URL`, `DB_NAME` |
| [Railway](#railway) | Required (or another Docker host) | Runs the app | the variables in `backend/.env.example` |
| [Claude Code](#claude-code) | Recommended | Your assistant for setting up and changing the app | none in the app |
| [Your domain](#your-own-domain) | Recommended | `app.yourdomain.co.uk` | `APP_BASE_URL` |
| [SendGrid](#sendgrid-email) | Optional, recommended | Email | `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME` |
| [Web push (VAPID)](#web-push-vapid-keys) | Optional, recommended | Phone notifications | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| [OwnerIQ](#owneriq) | Optional | Field numbers, Live Operations, Performance Hub, Timeline | `OWNERIQ_*` |
| [Anthropic API](#anthropic-api-claude) | Optional | The AI features | `ANTHROPIC_API_KEY` (+ optional model settings) |
| [S3-compatible storage](#s3-compatible-storage-eg-cloudflare-r2) | Optional | Where profile and badge photos are kept | `CI_S3_*` |
| [Replicate](#replicate) | Optional | Badge-photo background removal | `REPLICATE_API_TOKEN` |
| [Google Fonts](#google-fonts) | Automatic | Fonts in emails and server pages | none |
| [Expo push service](#expo-push-service) | Automatic, native builds only | Notifications to native app builds | none |

---

## GitHub

- **Powers:** stores your copy of the code. Railway deploys from it, and its Actions run the automatic checks (`.github/workflows/ci.yml`) on every push.
- **Needed:** yes.
- **Sign up:** [github.com/signup](https://github.com/signup). Keep your own copy **private** ([SETUP.md](SETUP.md), step 2).
- **Cost:** has a free plan, enough for this.

## MongoDB Atlas

- **Powers:** everything the app remembers: people, Bells, planners, training progress, OwnerIQ copies, photos (unless you add storage).
- **Needed:** yes. Any MongoDB works; Atlas is the easy hosted option.
- **Without it:** nothing runs.
- **Settings:** `MONGO_URL` (secret: it contains the database password), `DB_NAME`.
- **Sign up:** [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register).
- **Cost:** has a free tier. The free cluster is small and has **no backups**; OwnerIQ door logs make the database grow, so plan to move to a paid tier once you're live. The upgrade keeps the same connection string. Check [current pricing](https://www.mongodb.com/pricing).
- **Backups:** on a tier without backups, a super-admin can download the whole database from `/api/admin/db-export` (gzipped, every collection).

## Railway

- **Powers:** builds the app from the `Dockerfile` (the web app and the server in one image, configured by `railway.toml`) and runs it: the website, the API and every scheduled job. Redeploys on every push to `main`.
- **Needed:** a host is required. Railway is what this repo is set up for; any host that builds a Dockerfile and sets `PORT` can work.
- **Settings:** all of `backend/.env.example`, under the service's **Variables**. Railway sets `PORT` and `RAILWAY_GIT_COMMIT_SHA` itself.
- **Sign up:** [railway.com](https://railway.com), with your GitHub account.
- **Cost:** check [current pricing](https://railway.com/pricing). Pick a plan with enough memory for a web build plus a Python server; the smallest free allowance has proved too small for this app.

## Claude Code

- **Powers:** nothing inside the app. It's how you set up, rebrand, connect OwnerIQ and make changes without being a developer: this repo ships `/setup`, `/brand` and `/connect-owneriq`.
- **Needed:** recommended.
- **Get it:** [Claude Code setup](https://code.claude.com/docs/en/setup). It needs a paid Claude plan or an Anthropic Console account. This is separate from the app's own `ANTHROPIC_API_KEY`.

## Your own domain

- **Powers:** a proper address such as `app.yourdomain.co.uk` instead of `something.up.railway.app`.
- **Needed:** recommended. Use a subdomain, so your main website is untouched.
- **Settings:** `APP_BASE_URL=https://app.yourdomain.co.uk` once it works.
- **How:** [SETUP.md](SETUP.md), step 7. Railway issues the HTTPS certificate for you.

## SendGrid (email)

- **Powers:** welcome emails with first-login details when an admin adds someone, email verification codes, password resets, new-starter emails to coaches and advancement emails.
- **Needed:** optional but recommended: without it people can't reset their own password.
- **Without it:** each email is logged and skipped; "Forgot password" can't send anything. Admins can still set passwords for people.
- **Settings:** `SENDGRID_API_KEY` (secret), `SENDGRID_FROM_EMAIL` (must be verified in SendGrid under **Settings → Sender Authentication**; verifying your whole domain gives the best delivery), `SENDGRID_FROM_NAME`.
- **Sign up:** [sendgrid.com](https://sendgrid.com). Create an API key with **Mail Send** permission.
- **Cost:** check [current pricing](https://sendgrid.com/en-us/pricing).
- The code uses SendGrid's own library (`backend/core/email_utils.py`). Switching to another email provider means changing that one file.

## Web push (VAPID keys)

- **Powers:** notifications on phones that have installed the app to their home screen: nudges, reminders, inbox alerts, "Retrain needed" alerts, the Monday bulletin reminder.
- **Needed:** optional but recommended. There's no account to create: you generate a key pair once.
- **Without it:** no phone notifications. Everything still lands in the in-app **Inbox**.
- **Settings:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (secret), `VAPID_SUBJECT` (`mailto:you@yourdomain.co.uk`).
- **Generate:** with Node installed, run `npx web-push generate-vapid-keys` and copy the two keys straight into Railway. Generate them **once**: new keys mean everyone has to switch notifications on again.
- **Cost:** free. Apple's, Google's and Mozilla's push services deliver the messages.
- **iPhone:** notifications only work once the app has been added to the home screen (iOS 16.4 or later) and the person has allowed them.

## OwnerIQ

- **Powers:** Field KPIs, Live Operations, the Performance Hub, the Timeline, Bells goals and sign-ups filled in automatically, stages on the spider diagram, the roster check, and (only if you switch it on) changes written back to OwnerIQ.
- **Needed:** optional. OwnerIQ is where your BAs' door-by-door figures are recorded; the app reads them from there so nobody has to type them in. If you don't use OwnerIQ, leave it off.
- **Without it:** those screens are empty and Bells is filled in by hand.
- **Settings:** `OWNERIQ_EMAIL`, `OWNERIQ_PASSWORD` (secret), optional `OWNERIQ_API_BASE`, `OWNERIQ_MC_PINS`, `OWNERIQ_OFFICE_PINS`, `OWNERIQ_ROOT_USER_IDS`, `OWNERIQ_WRITES_ENABLED`, `OWNERIQ_LIVE_TTL`, `ROSTER_SHARE_TOKEN`.
- **How:** [OWNERIQ.md](OWNERIQ.md), or `/connect-owneriq` in Claude Code.
- **Cost:** part of your OwnerIQ subscription; nothing extra from this app.

## Anthropic API (Claude)

- **Powers:** AI reports on a person, the coaching assistant, the monthly planner coach, the Bells daily breakdown, quick quizzes for COD modules and coaching impacts (made in the background every 15 minutes), and reading photos of schedules and planner notes.
- **Needed:** optional.
- **Without it:** those buttons say the feature is off or unavailable. Everything else works.
- **Settings:** `ANTHROPIC_API_KEY` (secret; the old name `EMERGENT_LLM_KEY` is also read). Optional: `ANTHROPIC_MODEL`, `ANTHROPIC_VISION_MODEL`, `ANTHROPIC_MAX_TOKENS` (default 8192), `LLM_MAX_CONCURRENCY` (default 4 calls at once), `AI_HOURLY_LIMIT_PER_USER` (default 60 requests per person per hour).
- **Sign up:** [console.anthropic.com](https://console.anthropic.com) → API Keys. Add credit and **set a monthly spend limit**.
- **Cost:** pay per use; check [current pricing](https://www.anthropic.com/pricing).
- **Models:** one setting chooses the model for every AI feature: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`, the `FALLBACK_MODEL` in `backend/emergentintegrations/llm/chat.py`). Reading photos can use `ANTHROPIC_VISION_MODEL` instead. No feature names a model in code. Models are retired from time to time; if AI features start failing with a "model not found" error, set `ANTHROPIC_MODEL` to a current model id and deploy.

## S3-compatible storage (e.g. Cloudflare R2)

- **Powers:** keeps profile photos and ID-badge photos as files in a bucket instead of inside the database.
- **Needed:** optional. Worth adding once you have more than a handful of badges.
- **Without it:** photos are stored in MongoDB, which works but fills the database faster.
- **Settings:** `CI_S3_ENDPOINT`, `CI_S3_BUCKET`, `CI_S3_ACCESS_KEY_ID`, `CI_S3_SECRET_ACCESS_KEY` (secret), `CI_S3_REGION` (default `auto`). All four of the first four must be set.
- **Sign up:** [Cloudflare R2](https://developers.cloudflare.com/r2/) (create a bucket, then an API token with read and write access to it). AWS S3 or any S3-compatible store also works.
- **Cost:** R2 has a free tier; check [current pricing](https://developers.cloudflare.com/r2/pricing/).
- The bucket stays private: the app reads and serves the photos itself.

## Replicate

- **Powers:** the "remove background" button for badge photos.
- **Needed:** optional.
- **Without it:** that button reports it isn't configured; badges work with the photo as taken.
- **Settings:** `REPLICATE_API_TOKEN` (secret).
- **Sign up:** [replicate.com](https://replicate.com) → Account → API tokens.
- **Cost:** pay per use; check [current pricing](https://replicate.com/pricing).

## Google Fonts

Emails and the server's own pages (`/launch`, the public Bells and roster pages) load their fonts from Google Fonts (`backend/core/brand.py`). Nothing to set up. The app screens use fonts bundled in `frontend/assets/fonts/`.

## Expo push service

Only for native iPhone/Android builds of the app, which aren't set up in this repo (`frontend/README.md`). Native builds get notifications through Expo's push service with no keys. The installed web app uses web push (above).

---

## What's not used

The backend's `requirements.txt` includes a few libraries the code doesn't call (for example a payments library). They aren't services you need, and no setting turns them on.
