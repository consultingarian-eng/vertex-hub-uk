# Setup manual

This takes you from a blank computer to the app live on your team's phones, on your own database, hosting and domain. Allow about half a day. You do steps 1 and 2 yourself; from then on Claude Code can guide you (`/setup`) and check each step as you go. This manual is the same route written down, so you can read ahead or look something up.

Nothing here needs you to be a developer. Commands go into a terminal one line at a time: **Terminal** on a Mac, **PowerShell** on Windows.

## Contents

1. [Tools on your computer](#step-1--tools-on-your-computer)
2. [Get the code](#step-2--get-the-code)
3. [Your own MongoDB database](#step-3--your-own-mongodb-database)
4. [Settings](#step-4--settings-environment-variables)
5. [Run it on your own computer](#step-5--run-it-on-your-own-computer)
6. [Put it live on Railway](#step-6--put-it-live-on-railway)
7. [Connect your domain](#step-7--connect-your-domain)
8. [First admin login and first things to do](#step-8--first-admin-login)
9. [Install it on phones](#step-9--install-it-on-phones)
10. [Optional services](#step-10--optional-services)
11. [Make it yours: branding and content](#step-11--make-it-yours)
- [Day to day](#day-to-day)
- [Updating from upstream](#updating-from-upstream)
- [Every setting](#every-setting)
- [Troubleshooting](#troubleshooting)

## Accounts you'll need

| Service | What for | Needed? |
| --- | --- | --- |
| [GitHub](https://github.com/signup) | Holds your copy of the code | Required |
| [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) | The database | Required |
| [Railway](https://railway.com) | Runs the app | Required |
| [Claude](https://claude.ai) (a plan that includes Claude Code) | Your guide for setup and changes | Recommended |
| A domain you own | `app.yourdomain.co.uk` | Recommended |
| [SendGrid](https://sendgrid.com) | Welcome and password-reset emails | Optional, recommended |
| [OwnerIQ](https://owner-iq.ai) owner login | Field numbers, Live Operations, Performance Hub | Optional |
| [Anthropic Console](https://console.anthropic.com) | The app's AI features | Optional |
| [Cloudflare R2](https://developers.cloudflare.com/r2/) or another S3-compatible store | Photo storage | Optional |
| [Replicate](https://replicate.com) | Badge-photo background removal | Optional |

[SERVICES.md](SERVICES.md) explains each one: what it powers, what happens without it, and where to check pricing.

## Step 1 — Tools on your computer

Install these once, in this order. Allow about 45 minutes.

| # | Tool | What it's for | Get it |
| --- | --- | --- | --- |
| 1 | Git | Downloads and uploads code | Mac: run `git --version` and accept the offer to install. Windows: [git-scm.com/downloads/win](https://git-scm.com/downloads/win), default options |
| 2 | VS Code (optional) | An editor to look at files | [code.visualstudio.com](https://code.visualstudio.com) |
| 3 | Python **3.11 or newer** (3.13 works) | Runs the server on your computer | [python.org/downloads](https://www.python.org/downloads/): the big download button is fine if it offers 3.11 or newer. The live server runs 3.11 |
| 4 | Node.js **LTS** (20, 22 or 24) | Builds and runs the app screens | [nodejs.org](https://nodejs.org), the **LTS** version |
| 5 | Claude Code | Your assistant | [Claude Code setup](https://code.claude.com/docs/en/setup) |

**After installing Python**

- Mac: open Applications → the Python folder (for example Python 3.13) and double-click **Install Certificates.command**. Without it Python can't make secure connections to your database.
- Windows: on the installer's first screen, tick **Add python.exe to PATH**.

**Windows only, once:** PowerShell blocks scripts by default. Run this and answer **Y**:

```
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**Tell Git who you are (once):**

```
git config --global user.name "Your Name"
git config --global user.email "you@yourdomain.co.uk"
```

**Install Claude Code** (Mac: `curl -fsSL https://claude.ai/install.sh | bash`; Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`), then open a **new** terminal, run `claude` and log in.

**Check everything.** Mac: `git --version`, `node --version`, `python3 --version`, `claude --version`. Windows: the same with `py -3 --version` for Python. Four version numbers back, with Python on 3.11 or newer and Node on 20, 22 or 24 (not 25 or newer: use the **LTS** download), means step 1 is done. If a Mac still shows Python older than 3.11, install it from python.org and open a **new** Terminal.

## Step 2 — Get the code

The public repository is `github.com/consultingarian-eng/vertex-hub-uk`; its default branch is `main`. You'll make your **own private copy**: that's the one Railway deploys and where your branding and changes live, and the public one stays your source of updates.

1. Download it:

   ```
   git clone https://github.com/consultingarian-eng/vertex-hub-uk.git my-field-app
   cd my-field-app
   ```

2. At [github.com/new](https://github.com/new), create a **private** repository in your account (e.g. `my-field-app`), **completely empty**: no README, no .gitignore, no licence.
3. Point your copy at it, keeping the public one as `upstream`:

   ```
   git remote rename origin upstream
   git remote add origin https://github.com/<your-username>/my-field-app.git
   git push -u origin main
   ```

   If the push fails with `RPC failed; HTTP 400`, run `git config http.postBuffer 524288000` and push again.

4. Start Claude Code in that folder (`claude`), and type `/setup`. It works out where you are and takes you through steps 3 onwards, checking each one.

**What's in the folder**

| Folder | What it is |
| --- | --- |
| `backend/` | The server (Python, FastAPI). Talks to MongoDB, OwnerIQ and the AI; runs the scheduled jobs |
| `backend/seed/` | Starting content for a brand-new database: training manual, modules, COD, Campaign Knowledge |
| `backend/tests/` | Automated checks |
| `frontend/` | The app people use (Expo / React Native, shipped as a web app) |
| `frontend/app/` | One file per screen |
| `docs/` | These guides |
| `.claude/skills/` | The `/setup`, `/brand` and `/connect-owneriq` guides for Claude Code |
| `Dockerfile`, `railway.toml` | How Railway builds and runs it |
| `.github/workflows/ci.yml` | The checks GitHub runs on every push |

## Step 3 — Your own MongoDB database

The app keeps everything in MongoDB. Allow 15 minutes.

1. Sign up at [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register). Create an organisation and a project.
2. **Create a cluster:** Create → the free tier → provider and region close to your users (London or another European region) → Create.
3. **Database user:** the security wizard asks for a username and password. Use **letters and numbers only** in the password (symbols break the connection string). Save both in your password manager.
4. **Network access:** Security → Network Access → Add IP Address → **Allow access from anywhere** (`0.0.0.0/0`). Railway doesn't give your app a fixed address, so this is required; the password protects the database.
5. **Connection string:** your cluster → Connect → Drivers → Python. Copy the `mongodb+srv://…` string and put your real password in place of `<password>`.

That's `MONGO_URL`. Pick a short `DB_NAME` (for example `fieldapp` for the live app and `fieldapp_dev` for your computer); the database is created on first start.

**Plan for growth.** The free cluster is small and has **no backups**. OwnerIQ door logs make the database grow; when Atlas warns you about space, upgrade the cluster (it keeps the same connection string and adds backups). Until then, a super-admin can download a full backup from `https://<your app>/api/admin/db-export`.

## Step 4 — Settings (environment variables)

The app reads its settings from environment variables: **Variables** on Railway, and `backend/.env` on your computer. The full list, with a comment on every line, is [`backend/.env.example`](../backend/.env.example); [Every setting](#every-setting) below summarises it.

**Required block for Railway** (replace the angle brackets):

```
MONGO_URL=<connection string from step 3>
DB_NAME=<e.g. fieldapp>
JWT_SECRET=<48+ random characters, see below>
ADMIN_EMAIL=<your email>
ADMIN_PASSWORD=<a strong password>
ADMIN_NAME=<your name>
SEED_OFFICE_NAME=<your office's name>
TRUST_PROXY_HEADERS=true
```

- **`JWT_SECRET`** signs everyone's logins. It must be at least 32 characters or the server won't start. Generate one: Mac `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`, Windows `py -3 -c "import secrets; print(secrets.token_urlsafe(48))"`. Use it nowhere else. Changing it logs everyone out.
- **`ADMIN_EMAIL` / `ADMIN_PASSWORD`** create your super-admin on the **first** start only. After that, change your password in the app (**Profile → Change password**); a restart or deploy never resets it. Forgotten it? See [Locked out of the owner account](#locked-out-of-the-owner-account).
- **`SEED_OFFICE_NAME`** names the one office created on the very first start. It's only read when there are no offices yet, so set it before your first deploy. Add more offices later in **Admin → Offices**.
- **`DB_NAME`**: always set it. Without it the app uses a database called `test_database`.
- **`TRUST_PROXY_HEADERS=true`** belongs on Railway only, never on your computer. On Railway it is already on when you leave it blank (the app recognises a Railway deploy), so setting it to `true` there is optional but makes it obvious; only ever set it to `false` if you know why. With it off, every visitor looks as if they come from Railway's own address, so every per-address limit is shared by everyone: the login limit (50 failed attempts per address in 15 minutes; see [Login limits](#login-limits)) can lock the whole team out, and 10 wrong guesses at a public Bells share code or the roster link from anyone block that page for every viewer for 15 minutes, even with the right code. The server logs a warning at start-up when it runs on Railway with this set to `false`. With it on, the app takes the visitor's address from the **last** entry of the `X-Forwarded-For` header, the one Railway's proxy adds; anything before it was sent by the visitor and is ignored. If you put another proxy you control in front of Railway (a CDN, for example), also set `TRUSTED_PROXY_HOPS=2`.
- **`APP_BASE_URL`** comes in step 7.

Time zone, language and money are already UK: Europe/London, British English, £.

**Never commit a real value.** `.env` files are ignored by git. If a key ever leaks, rotate it at the provider and update Railway.

## Step 5 — Run it on your own computer

Optional, but it's how you try changes safely before they go live. About 15 minutes the first time.

**Use a separate database name locally** (`DB_NAME=fieldapp_dev`). A local server runs the same scheduled jobs as the live one. Pointed at the live database, or given your SendGrid, OwnerIQ or VAPID keys, it would message your team. Keep those keys out of your local file.

**1. `backend/.env`** with these lines. The quickest start is to copy the example file and edit it: Mac `cp backend/.env.example backend/.env`, Windows `Copy-Item backend\.env.example backend\.env`. Then open `backend/.env` in VS Code (or Windows Notepad) and fill in only the lines below (see "Making a `.env` file" after the next block if you'd rather create it from scratch):

```
MONGO_URL=<connection string from step 3>
DB_NAME=fieldapp_dev
JWT_SECRET=<any 48+ random characters>
ADMIN_EMAIL=<your email>
ADMIN_PASSWORD=<a password>
COOKIE_SECURE=false
```

`COOKIE_SECURE=false` is needed because your computer has no HTTPS.

**Making a `.env` file without it becoming `.env.txt`.** A name that starts with a dot is a "dotfile". Windows Notepad's **Save As** and Mac TextEdit like to add `.txt` to it, and the app then can't find it. Safer ways:

- Mac (Terminal, in the repo folder): `cp backend/.env.example backend/.env`. Edit it in VS Code (`code backend/.env`). In TextEdit use **Format → Make Plain Text** first, and if Finder is hiding dotfiles press Cmd+Shift+. to show them.
- Windows (PowerShell, in the repo folder): `Copy-Item backend\.env.example backend\.env`, then `notepad backend\.env`. In File Explorer choose **View → Show → File name extensions** so you can see any `.txt`.
- Check: Mac `ls -a backend`, Windows `Get-ChildItem -Force backend`. You should see `.env`, not `.env.txt`. If you see `.env.txt`, rename it: Windows `Rename-Item backend\.env.txt .env`, Mac `mv backend/.env.txt backend/.env`.
- The `frontend/.env` in the next steps is one line, so it's easiest to create from the terminal: Mac `echo 'EXPO_PUBLIC_BACKEND_URL=http://localhost:8000' > frontend/.env`, Windows `Set-Content -Path frontend\.env -Value 'EXPO_PUBLIC_BACKEND_URL=http://localhost:8000'`.

**2. Terminal 1, the server.** Mac:

```
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
uvicorn server:app --reload --port 8000
```

Windows: the same, with `py -3 -m venv venv` and `venv\Scripts\activate`.

The first start prints `Seeded admin: …` and `Seeded office: …`; later starts print `Background scheduler started`. http://localhost:8000/health should say `{"status":"ok"}`.

**3. Terminal 2, the app.** Create `frontend/.env` containing one line, `EXPO_PUBLIC_BACKEND_URL=http://localhost:8000` (the terminal commands above do it), then:

```
cd frontend
npx --yes yarn@1.22.22 install
npx expo start --web --port 8081
```

Open http://localhost:8081 and log in with your admin email and password.

**The checks** (GitHub runs the same on every push). From the repo folder, with the backend venv active:

```
cd backend
python -m pytest tests -q
cd ..
python -m pytest tests -q
cd frontend
npx tsc --noEmit
npx expo export --platform web
```

All tests should pass, the type check prints nothing, and the export ends with "Exported". Or ask Claude: *"run the backend tests, the repo tests, the type check and the web export, and tell me if anything fails"*.

## Step 6 — Put it live on Railway

Railway builds the app from your GitHub copy using the `Dockerfile` (the web app is built with Node, then served by the Python server: one service does everything) and redeploys on every push to `main`. Allow 20 minutes, mostly waiting for the first build.

1. Sign up at [railway.com](https://railway.com) **with your GitHub account** and choose a paid plan with enough memory (check [current pricing](https://railway.com/pricing)); the smallest free allowance is too small to build this app.
2. **New Project → Deploy from GitHub repo →** your private copy. If it isn't listed, click **Configure GitHub App** and give Railway access to it.
3. Open the service → **Variables → Raw Editor**, paste the required block from step 4 with your values, click **Update Variables**, then **Deploy** on the banner. Railway holds every variable change until you deploy.
4. Service → **Settings**:
   - **Region:** a European one (e.g. EU West), close to your users and your database.
   - **Wait for CI:** on. Railway then deploys a push only after GitHub's checks pass (Railway's own build doesn't run the tests).
   - **Networking → Generate Domain** for a temporary `….up.railway.app` address.
5. `railway.toml` already sets the health check (`/health`) and restart policy. Watch **Deployments → View logs**: on the first start you'll see `Seeded admin: …` and `Seeded office: …`.
6. Open the Railway address and log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Check it from a terminal: `curl https://<your address>/health` returns `{"status":"ok"}` and `curl https://<your address>/api/version` returns the deployed version.

**Railway CLI (optional)** for logs in the terminal: `npm install -g @railway/cli`, then `railway login`, `railway link`, `railway logs`. `railway variables` prints your secrets, so never share its output.

## Step 7 — Connect your domain

Use a subdomain such as `app.yourdomain.co.uk`. Allow 10 minutes, then up to an hour for the padlock.

1. Railway → service → **Settings → Networking → + Custom Domain**, type your subdomain.
2. Railway shows the DNS records to add. **Add all of them** (usually a CNAME and a TXT) wherever your domain's DNS is managed:

   | Type | Name / Host | Value |
   | --- | --- | --- |
   | CNAME | `app` | the target Railway shows |
   | TXT | the name Railway shows | the verification value Railway shows |

3. Wait for Railway to show the domain as active; it then issues an HTTPS certificate automatically.
4. Add `APP_BASE_URL=https://app.yourdomain.co.uk` in Railway → Variables, then **Deploy**. Emails and notification links now use your domain.

**Gotchas:** a missing TXT record shows a 404 even when the CNAME works; a bare domain (no `app.`) only works where your DNS provider supports CNAME flattening or ALIAS records. See [Railway's domain guide](https://docs.railway.com/networking/domains/working-with-domains).

**If your DNS is on Cloudflare with the proxy (orange cloud) on:** set SSL/TLS to **Full**, and in Railway → Variables add `TRUSTED_PROXY_HOPS=2` (keep `TRUST_PROXY_HEADERS=true`), then **Deploy**. The app finds the visitor's real address by counting back along the `X-Forwarded-For` header from the right: `TRUSTED_PROXY_HOPS` is how many proxies you control sit in front of the app (default 1 is Railway alone; Cloudflare plus Railway is 2). Left at 1, every visitor would look like a Cloudflare address, and the shared login limit could lock the whole team out. With the orange cloud off (DNS only), leave it at 1.

## Step 8 — First admin login

Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. You're the **super-admin**: you see every office and can do everything. There is no public sign-up: accounts are made by admins.

**First things to do**

- [ ] **Admin → Offices**: your office is there. Add more with **Create New Office**.
- [ ] **Admin → Users → Add Coach / BA** for your coaches and admins. For a brand-new BA, **Home → Add new starter** does the same and starts their Day 1–8. With email set up, each person gets a welcome email with their first-login details.
- [ ] **Coach+**: on a Coach's card in Admin → Users, **Make Coach+** to let them see the whole office and use Badges.
- [ ] **Badge numbers**: on each person's card, **Badge number → Add badge number**, exactly as OwnerIQ has it (links them to their field numbers).
- [ ] **Earnings Calculator → Rates**: check the pay rates for your office.
- [ ] **Manual** (and its **KPIs** tab for daily targets) and **COD Vetting** (`/cod-vetting`): read through and edit anything that isn't how you work.
- [ ] **Schedule → Edit timetable**: your office week.

## Step 9 — Install it on phones

There's no App Store download: the app installs from the browser as a home-screen app.

- Send your team **`https://app.yourdomain.co.uk/launch`**. It shows the steps for their phone.
- **iPhone:** open the link in **Safari** → Share → **Add to Home Screen**. Notifications only work once it's on the home screen.
- **Android:** open it in **Chrome** → ⋮ → **Add to Home screen** (or **Install app**).
- When you deploy an update, an open app shows **Update ready — tap to refresh**; otherwise it updates next time it's opened.

## Step 10 — Optional services

Add these one at a time after you're live. Each has a section in [SERVICES.md](SERVICES.md).

1. **Email (SendGrid).** Set `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` (verified in SendGrid → Settings → Sender Authentication) and `SENDGRID_FROM_NAME`. Test: "Forgot password" on your own account.
2. **Push notifications.** Run `npx web-push generate-vapid-keys` once and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT=mailto:<your email>`. Test: install on your phone from `/launch` and allow notifications.
3. **OwnerIQ.** Follow [OWNERIQ.md](OWNERIQ.md) or run `/connect-owneriq`. Keep `OWNERIQ_WRITES_ENABLED` off at first.
4. **AI features.** Set `ANTHROPIC_API_KEY` (after setting a monthly spend limit in the Anthropic Console). Test: generate an AI report on a person.
5. **Photo storage.** Set the four `CI_S3_*` values for an R2 or S3 bucket.
6. **Badge background removal.** Set `REPLICATE_API_TOKEN`.

## Step 11 — Make it yours

- **Branding:** name, logos, icons, colours, fonts and the badge template: [BRANDING.md](BRANDING.md), or `/brand` in Claude Code.
- **Content:** the app ships with the training and campaign material Vertex Labs built for one campaign: the **National Deaf Children's Society (NDCS)**, through the fundraising agency **Acwyre**. The seed files name them throughout, including the chain NDCS → Acwyre → Vertex Organisation → Brand Ambassador → supporter. It covers the BA Academy days, the COD, the Campaign Knowledge playbook (pitch, solicitation statement, Gift Aid, welcome call, who not to sign up, terminology), the daily targets and the pay plan. Keep what fits, and replace anything that's specific to a campaign or charity you don't work with: never present another charity's facts, figures or wording as yours. **Where to replace it:** before your first start of a new database, edit the files in `backend/seed/` (training manual, Campaign Knowledge topics, modules) and `backend/seed_data.py` (day targets and the first manual); ask Claude Code to do a careful find-and-replace for the names. Once the app is live, use the admin screens instead: **Manual** (and its **KPIs** tab), **Campaign Knowledge**, **COD Vetting** and **Earnings → Rates**.
- **Seed files vs the live app:** `backend/seed/*.json`, `backend/seed_data.py` and `backend/core/module_seed.py` only fill a **brand-new** database. Once you're live, change content in the app (Manual's pencil, COD Vetting, Earnings → Rates, Schedule). Editing a seed file changes nothing in an existing database unless you also ask Claude to write the change into the database.

## Day to day

**Change in the app, not the code:** pay rates (Earnings Calculator → Rates), daily targets (Manual → KPIs), training content (Manual, COD Vetting), the office timetable (Schedule), people and offices (Admin).

**For anything else**, the routine is: describe it to Claude Code, look at it locally (step 5), run the checks, then commit and push. GitHub runs its checks, Railway deploys a few minutes later, and phones show **Update ready**.

Prompts that work well:

> Something's wrong on the Bells screen: [describe it or paste a screenshot]. Find the cause before changing anything.

> Add a Campaign Knowledge topic called "…" in the Quality section with this text: … Put it in the live app as well as the seed file.

**Undo a bad deploy:** Railway → Deployments → open the last good one → **Redeploy**. Then ask Claude to `git revert` the bad commit and push.

## Updating from upstream

Improvements to the public repository arrive as new commits there. To bring them into your copy:

```
git status
git add -A
git commit -m "My changes"
git pull --no-edit upstream main
```

Commit your own changes first (the first three lines; skip them if `git status` says nothing to commit): Git won't merge on top of unsaved work. `git pull --no-edit upstream main` then fetches the public repository's `main` and merges it into yours in one go, accepting Git's standard merge message so no editor opens. Before `git add -A`, check `git status` lists no `.env` file.

If Git reports conflicts (most likely in files you rebranded), ask Claude Code: *"I merged upstream and got conflicts. Keep my branding and content, take their code changes, and explain each conflict."* Then run the checks and push. Read the upstream commit messages first so you know what's coming.

## Every setting

Full comments in [`backend/.env.example`](../backend/.env.example). **Secret** = set your own; there is no default and it must never be shared or committed.

| Variable | Needed? | What it does | Where to get it |
| --- | --- | --- | --- |
| `MONGO_URL` | **Required. Secret** | Database connection string | Atlas → Connect → Drivers |
| `DB_NAME` | **Required** | Database name | You choose |
| `JWT_SECRET` | **Required. Secret** | Signs logins (32+ characters) | Generate (step 4) |
| `ADMIN_EMAIL` | **Required** | Super-admin login | Yours |
| `ADMIN_PASSWORD` | **Required. Secret** | Super-admin password, used when the account is first created | You choose |
| `ADMIN_PASSWORD_RESET` | Recovery only | `true` sets the super-admin's password back to `ADMIN_PASSWORD` on the next start. Remove it straight after | — |
| `ADMIN_NAME` | Optional (default "Admin") | Super-admin display name | You choose |
| `SEED_OFFICE_NAME` | Optional (default "Head Office") | First office's name, first start only | You choose |
| `APP_BASE_URL` | Recommended | Your public address, for links in emails and notifications | Step 7 |
| `TRUST_PROXY_HEADERS` | On by default on Railway (blank or `true`); never on locally | Real visitor addresses for the login, share-code and roster limits (the last `X-Forwarded-For` hop). Set to `false` on Railway = one shared limit for everyone | — |
| `TRUSTED_PROXY_HOPS` | Rarely (default 1; `2` with Cloudflare's proxy in front of Railway) | How many proxies you control sit in front of the app. Only read when `TRUST_PROXY_HEADERS` is on | Step 7 |
| `COOKIE_SECURE` | Default true; `false` only locally | HTTPS-only login cookies | — |
| `CORS_ALLOWED_ORIGINS` | Rarely | Other web addresses allowed to call the API. Unset on a local run, the Expo dev addresses (`localhost:8081`, `:19006`) are allowed; on Railway (or with `APP_ENV=production`) nothing extra is | — |
| `APP_ENV` | Off Railway only | `production` on a host other than Railway, so localhost isn't trusted | — |
| `APP_TIMEZONE` | Optional (Europe/London) | Time zone for "today" and every job | — |
| `APP_NAME`, `ORG_NAME` | Optional | Names in emails, `/launch`, notifications, AI text | [BRANDING.md](BRANDING.md) |
| `SENDGRID_API_KEY` | Optional. **Secret** | Sends email | SendGrid → API Keys |
| `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME` | With SendGrid | Verified sender and display name | SendGrid → Sender Authentication |
| `OWNERIQ_EMAIL` | Optional | OwnerIQ owner login | Your OwnerIQ account |
| `OWNERIQ_PASSWORD` | With OwnerIQ. **Secret** | Its password | Your OwnerIQ account |
| `OWNERIQ_API_BASE`, `OWNERIQ_MC_PINS`, `OWNERIQ_OFFICE_PINS`, `OWNERIQ_ROOT_USER_IDS`, `OWNERIQ_WRITES_ENABLED`, `OWNERIQ_LIVE_TTL` | Optional | OwnerIQ host, companies, office mapping, owner detection, write-back switch, cache time | [OWNERIQ.md](OWNERIQ.md) |
| `ROSTER_SHARE_TOKEN` | Optional. **Secret** | Turns on `/public/roster/<token>`. At least 32 characters, or the page stays off | Mac `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`, Windows `py -3 -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `ANTHROPIC_API_KEY` | Optional. **Secret** | AI features (`EMERGENT_LLM_KEY` also read) | Anthropic Console → API Keys |
| `ANTHROPIC_MODEL` | Optional (default `claude-sonnet-5-5`) | The model every AI feature uses. The only place a model is chosen | Anthropic's models page |
| `ANTHROPIC_VISION_MODEL` | Optional | A different model just for reading photos and sheets (falls back to `ANTHROPIC_MODEL`) | — |
| `ANTHROPIC_MAX_TOKENS`, `LLM_MAX_CONCURRENCY` | Optional | Output cap (8192), parallel calls (4) | — |
| `AI_HOURLY_LIMIT_PER_USER` | Optional (60) | AI model calls one person can cause per hour, across every AI feature (a written-request report counts 2; generating a quiz the first time counts 1, and a failed quiz isn't retried for an hour) | — |
| `VAPID_PUBLIC_KEY` | Optional | Web push public key | `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | With push. **Secret** | Web push private key | Same command |
| `VAPID_SUBJECT` | Optional | Contact for push services | `mailto:` your email |
| `CI_S3_ENDPOINT`, `CI_S3_BUCKET`, `CI_S3_ACCESS_KEY_ID`, `CI_S3_REGION` | Optional | Photo storage bucket | Cloudflare R2 / S3 |
| `CI_S3_SECRET_ACCESS_KEY` | With storage. **Secret** | Bucket secret key | Same |
| `BADGE_ORG_NAME`, `BADGE_VERIFY_PHONE`, `BADGE_QR_URL_TEMPLATE` | Optional | Badge wording and QR | [BRANDING.md](BRANDING.md#5-the-id-badge) |
| `REPLICATE_API_TOKEN` | Optional. **Secret** | Badge-photo background removal | replicate.com → API tokens |
| `SALES_PATH_ENABLED`, `SALES_PATH_OFFICES`, `SALES_PATH_ANCHOR_WAIVER_BEFORE`, `SALES_PATH_RAMP_SINCE` | Optional (off) | The Sales Development Path and its start dates | — |
| `MANUAL_EDITOR_PASSWORD` | Optional. **Secret** | Shared password for `/api/manual-editor`. At least 16 characters, or shared access stays off (admins can still use it signed in). After 30 wrong tries from anywhere in 15 minutes it is refused for everyone until the 15 minutes pass | Mac `python3 -c "import secrets; print(secrets.token_urlsafe(24))"`, Windows `py -3 -c "import secrets; print(secrets.token_urlsafe(24))"` |
| `DISABLE_SEED_LOADER`, `DISABLE_SEED_HEAL` | Recovery only | Skip the content import / repair on start | — |
| `WEB_DIST_PATH` | Leave unset | Where the built web app is (the Dockerfile sets it) | — |
| `PORT`, `RAILWAY_GIT_COMMIT_SHA` | Set by Railway | Port to listen on; deployed version | — |
| `EXPO_PUBLIC_BACKEND_URL` | `frontend/.env`, locally only | Where the local app finds the local server | `http://localhost:8000` |
| `EXPO_PUBLIC_APP_TIMEZONE` | Build-time, optional | The screens' time zone (default Europe/London) | — |

## Troubleshooting

| What you see | Likely cause | Fix |
| --- | --- | --- |
| A red ✗ on your commit in GitHub | A test or the type check failed | Open the failed check, copy the error, paste it to Claude. With **Wait for CI** on, Railway won't deploy it |
| Railway build fails | A package didn't install or the web build broke | Copy the red error from the build log and paste it to Claude |
| Logs: `JWT_SECRET must be configured with at least 32 characters` | `JWT_SECRET` missing or short | Generate one (step 4) |
| Logs: `ServerSelectionTimeoutError` | Atlas is blocking Railway | Atlas → Network Access must include `0.0.0.0/0` |
| Logs: `bad auth : Authentication failed` | Wrong user or password in `MONGO_URL` | Re-copy the string; use a letters-and-numbers password |
| `CERTIFICATE_VERIFY_FAILED` on a Mac | Python's certificates aren't installed | Applications → your Python folder → **Install Certificates.command** |
| Can't log in as admin | You changed the password in the app (changing `ADMIN_PASSWORD` later does nothing), or `ADMIN_EMAIL` doesn't match | **Forgot password** if email (SendGrid) is set up; otherwise the `ADMIN_PASSWORD_RESET` route in [Locked out of the owner account](#locked-out-of-the-owner-account) |
| "Too many attempts. Try again later." (login, public Bells page or roster link) | Too many failed attempts in 15 minutes (see [Login limits](#login-limits)) | Wait 15 minutes. On Railway, check `TRUST_PROXY_HEADERS=true` (the start-up log warns when it's off) |
| "Untrusted request origin" | The app was opened from a different address than the server | Use one address. Only set `CORS_ALLOWED_ORIGINS` if you split them on purpose |
| "Someone in your office already uses that name" | Two people in one office can't share a display name | Add a middle initial or a surname |
| "You've used the AI a lot this hour" | One person hit `AI_HOURLY_LIMIT_PER_USER` | Wait, or raise the limit (and keep a spend limit on your Anthropic key) |
| Public Bells link says it has expired | Its share code is shorter than 16 characters (set before the rule) | **Admin → Offices → Public Bells Share Link → Generate**, then send the new link |
| AI features fail with "model not found" | The model was retired | Set `ANTHROPIC_MODEL` to a current model id and **Deploy** |
| Wrong office name | `SEED_OFFICE_NAME` was set after the first start | Ask Claude to rename the office in the database, or create a new office and move people |
| No emails | SendGrid sender not verified, or key/plan issue | SendGrid → Sender Authentication and Activity; check the Railway logs for the email error |
| No push notifications | VAPID keys missing, or the phone hasn't installed the app | Set the VAPID variables; on iPhone, add to home screen first and allow notifications |
| Field KPIs / Live Operations empty | OwnerIQ not connected, or people not linked | [OWNERIQ.md](OWNERIQ.md) |
| AI buttons say they're off or busy | `ANTHROPIC_API_KEY` missing, out of credit, or too many at once | Add the key / top up; raise `LLM_MAX_CONCURRENCY` carefully |
| A phone shows an old version | It hasn't reloaded since the deploy | Tap **Update ready**, or close the app fully and reopen |
| Old icon or name on a phone | The home-screen icon is copied at install | Remove it from the home screen and add it again |

### Locked out of the owner account

`ADMIN_PASSWORD` only sets the password when the account is first made, so changing it later doesn't log you in. Two ways back in:

1. **Forgot password** on the login screen. This **needs email**: it sends a code through SendGrid, so it does nothing useful until SendGrid is set up (step 10).
2. **No email? Use `ADMIN_PASSWORD_RESET`.** On Railway → Variables:
   1. Check `ADMIN_EMAIL` is the email you log in with.
   2. Set `ADMIN_PASSWORD` to a **new** password.
   3. Add `ADMIN_PASSWORD_RESET=true`, click **Update Variables**, then **Deploy**.
   4. When the deploy finishes, log in with the new password. (The log says `ADMIN_PASSWORD_RESET: the super-admin password was reset`. Everyone else is unaffected; the owner's other sessions are signed out.)
   5. **Delete `ADMIN_PASSWORD_RESET`** and deploy again. While it's set, any restart puts the password back to `ADMIN_PASSWORD` if you've changed it in the app since.

### Login limits

Failed logins are counted two ways, each over 15 minutes, and a successful login clears that email's count:

- **Per email address: 10 failures** for one email, from anywhere. This stops someone guessing one person's password, but it also means a person who mistypes 10 times is paused for up to 15 minutes even on their own phone.
- **Per visitor address: 50 failures** from one internet address (which is why `TRUST_PROXY_HEADERS=true` matters on Railway: it makes "address" the visitor's own).

Either one shows "Too many attempts. Try again later." The counts are kept in the server's memory, so a deploy or restart clears them.

When something breaks, give Claude the exact error text or a screenshot and ask it to find the cause before it changes anything.
