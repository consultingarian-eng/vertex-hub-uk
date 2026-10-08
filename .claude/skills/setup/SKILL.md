---
name: setup
description: Guide the office owner through setting up and hosting their own copy of this field app from scratch, as a teacher - tools, their own private GitHub copy, MongoDB Atlas, settings, a local run, Railway, their domain, the first admin login, installing on phones, then the optional services. Checks each step before moving on and never echoes secrets. Use whenever they ask to set up, install, host, deploy or go live, connect a database or domain, turn on email, notifications or AI, or ask "what's next?" about getting the app running.
argument-hint: "[step number, e.g. 3]"
---

# Set up and host the app, as a teacher

The person you're helping owns a UK door-to-door fundraising office and wants their own copy of this app running. They may be new to development and want to **understand** each step, not just get it done.

The source of truth is `docs/SETUP.md`. Read it now, before anything else, and follow its order, commands and settings. Also skim `README.md`, `docs/SERVICES.md` and `backend/.env.example`. If this skill and `docs/SETUP.md` ever disagree, trust `docs/SETUP.md` (and the code over both) and say so.

If they gave a step number (`$ARGUMENTS`), start there. Otherwise work out where they are (**Where are they?** below) and pick up at the first step that isn't done.

## How to teach

- **Ask once which computer they're on** (Mac or Windows) and give only that platform's commands from then on.
- **One step at a time.** For each step:
  1. Say in one or two sentences what it is and why the app needs it. ("MongoDB Atlas is the online database where the app keeps every person, sign-up and planner. We're making one that belongs to you.")
  2. Give the exact clicks or commands, what they'll see, and which option to choose.
  3. Wait for them to say it's done.
  4. Check it yourself (table below) and tell them plainly what you checked and that it passed.
- **They do the human parts:** creating accounts, verifying email, accepting terms, card details, two-factor codes. You can't and shouldn't.
- **You may run commands for them** (installs, `pip`, the local server, tests, the Railway CLI) once they've agreed. Say what each command does first.
- **When something fails,** explain the cause in plain English and fix the cause. Don't stack workarounds. The traps below cover most failures.
- **Show progress:** a short checklist of steps 1–11 at the top of your messages, ticked as each passes.
- **Keep it short.** They're following along with their hands busy.

## Secrets: the rules

Secrets: `MONGO_URL` (contains the database password), `JWT_SECRET`, `ADMIN_PASSWORD`, `SENDGRID_API_KEY`, `OWNERIQ_PASSWORD`, `ANTHROPIC_API_KEY`, `VAPID_PRIVATE_KEY`, `CI_S3_SECRET_ACCESS_KEY`, `REPLICATE_API_TOKEN`, `ROSTER_SHARE_TOKEN`, `MANUAL_EDITOR_PASSWORD`.

- **Never echo a secret back.** If you need to refer to one, show at most its first 4 characters. Never `cat` a `.env` file or print `railway variables` into the conversation. Once `backend/.env` exists (it is made in step 5, not before), check a value is set by testing for presence, e.g. `python -c "from dotenv import dotenv_values as d; v=d('backend/.env'); print({k: bool(v.get(k)) for k in ['MONGO_URL','JWT_SECRET','ADMIN_PASSWORD']})"` (from the repo root with the backend venv active).
- **Generate `JWT_SECRET` straight into place**, so it never appears in the chat. For `backend/.env`, at step 5 once the file exists: Mac `python3 -c "import secrets; print('JWT_SECRET=' + secrets.token_urlsafe(48))" >> backend/.env`; Windows `py -3 -c "import secrets; print('JWT_SECRET=' + secrets.token_urlsafe(48))" | Add-Content backend\.env`. For Railway, have them run the generator in their own terminal and paste the result into Railway themselves, or, on a Mac, if the Railway CLI is linked and they agree, `railway variables --set "JWT_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"` (prints nothing secret; on Windows they paste it into Railway themselves).
- **Prefer that they paste secrets into Railway → Variables themselves.** If they'd rather you write `backend/.env`, have them paste the value into the file in their editor; if they paste it into the chat anyway, use it, don't repeat it, and remind them it's a secret.
- **Never commit `.env` files.** Run `git status` before every commit and make sure no `.env` appears.
- **Never set `OWNERIQ_WRITES_ENABLED`** during setup. That's a later, deliberate decision (`/connect-owneriq`).

## Where are they? (check; don't ask)

| Step | How to check |
| --- | --- |
| 1. Tools | `git --version`; `node --version` (20, 22 or 24, the LTS versions; warn on 25 or newer, where `corepack` is missing); `python3 --version` (Mac) or `py -3 --version` (Windows) must say 3.11 or newer (3.13 works); `claude --version`; `git config user.name` returns a name |
| 2. Code | `git remote -v`: `origin` is **their own private repo** and `upstream` is `github.com/consultingarian-eng/vertex-hub-uk`. If `origin` still points at the public repo, walk them through step 2 of the manual (empty private repo, rename, push). Never suggest pushing to the public repo |
| 3. Database | **No `.env` yet**: it is made in step 5. Ask them to confirm, without pasting anything, that the Atlas cluster exists, the database user and a letters-and-numbers password are saved in their password manager, Network Access has `0.0.0.0/0`, and they have the `mongodb+srv://…` string with the password filled in. The actual connection test happens in step 5, when the server starts and prints `Seeded admin: …` / `Seeded office: …` |
| 4. Settings | They have their **Railway required block** ready (kept in their notes or password manager, not in a file in the repo yet), including `TRUST_PROXY_HEADERS=true`, their own `DB_NAME` and `SEED_OFFICE_NAME`, and a `JWT_SECRET` they generated (never shown to you) |
| 5. Local run | `backend/.env` now exists and is called `.env`, not `.env.txt` (`ls -a backend` / `Get-ChildItem -Force backend`). Presence check only: `DB_NAME` ending in `_dev`, `COOKIE_SECURE=false`, a `JWT_SECRET` of 32+ characters (check the length, not the value), `MONGO_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`; and **no** `SENDGRID_*`, `OWNERIQ_*` or `VAPID_*` lines. `backend/venv` exists; `curl http://localhost:8000/health` (`curl.exe` on Windows) returns `{"status":"ok"}`; `frontend/node_modules` exists; they can log in at http://localhost:8081 |
| 6. Railway | `curl https://<their railway address>/health` returns ok and `/api/version` returns a version; they can log in. With the CLI: `railway status`, `railway logs` |
| 7. Domain | `dig +short CNAME app.<their domain>` (or `nslookup -type=CNAME`) points at Railway; the TXT record resolves; `curl https://app.<their domain>/health` is ok over HTTPS; `APP_BASE_URL` is set to that address |
| 8. First login | They're in as super-admin; Admin → Offices shows their office; they've added at least one Coach or BA |
| 9. Phones | `/launch` opens on their phone and the app is on their home screen |
| 10. Optional | Each service they chose passes its check (below) |
| 11. Make it yours | Offer `/brand` and `/connect-owneriq` |

## Traps that stop people

- **Mac, Python can't connect** (`CERTIFICATE_VERIFY_FAILED`): Applications → the Python folder → Install Certificates.command.
- **`.env` ends up as `.env.txt`** (Notepad or TextEdit added an extension): create it from the terminal instead, with the `cp` / `Copy-Item` commands in step 5 of `docs/SETUP.md`, and rename if needed.
- **Windows, "running scripts is disabled"**: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Use `py -3`, not `python3`. Older PowerShell doesn't accept `&&`: one command per line.
- **Atlas `bad auth`**: wrong password in `MONGO_URL`, or symbols in it. Make a new database user with a letters-and-numbers password.
- **Atlas timeout** (`ServerSelectionTimeoutError`): Network Access must include `0.0.0.0/0`.
- **Server won't start: `JWT_SECRET must be configured with at least 32 characters`.**
- **Railway variables don't take effect**: Railway stages changes; they must click **Deploy** on the banner after **Update Variables**.
- **Everyone locked out with "Too many attempts"**: `TRUST_PROXY_HEADERS` set to `false` on Railway (leave it blank or `true` there; never set it locally), or Cloudflare's proxy is in front and `TRUSTED_PROXY_HOPS=2` isn't set. Separately, one person typing a wrong password 10 times is paused for 15 minutes (the per-email limit; the per-address limit is 50). See "Login limits" in `docs/SETUP.md`.
- **Wrong office name**: `SEED_OFFICE_NAME` is only read on the very first start. Set it before the first deploy.
- **`DB_NAME` missing**: the app silently uses a database called `test_database`. Always set it.
- **Owner can't log in after changing `ADMIN_PASSWORD`**: it only sets the password when the account is first made. "Forgot password" works only if SendGrid email is set up. With no email: set `ADMIN_PASSWORD` to a new password and `ADMIN_PASSWORD_RESET=true` for one deploy (`ADMIN_EMAIL` must be their login email), log in, then make sure they remove `ADMIN_PASSWORD_RESET` and deploy again (`docs/SETUP.md`, "Locked out of the owner account").
- **`MANUAL_EDITOR_PASSWORD` or `ROSTER_SHARE_TOKEN` "doesn't work"**: shorter than 16 / 32 characters keeps the feature off. Generate a long one.
- **Railway build runs out of memory**: they need a plan with more memory.
- **Push fails with `RPC failed; HTTP 400`**: `git config http.postBuffer 524288000`, push again.
- **Tests pass locally but a deploy breaks**: Railway doesn't run the tests. Turn on Settings → **Wait for CI**.
- **Domain shows 404**: the TXT record is missing. With Cloudflare's orange-cloud proxy on, also set SSL/TLS to Full and `TRUSTED_PROXY_HOPS=2`. **No padlock yet**: the certificate can take up to an hour. A bare domain needs CNAME flattening/ALIAS support: use `app.`.
- **Local copy against the live database**: never. Locally `DB_NAME=<name>_dev`, and no SendGrid, OwnerIQ or VAPID keys in `backend/.env`.

## After it's live: optional services, one at a time

Recommend this order. For each, say what it unlocks, point to its section in `docs/SERVICES.md` for pricing, and check it:

1. **Email (SendGrid)**: welcome emails, verification codes, password resets. Check: "Forgot password" on their own account; the email arrives.
2. **Push notifications (VAPID)**: `npx web-push generate-vapid-keys`, keys pasted into Railway by them. Check: install from `/launch` on their phone, switch notifications on in the app and allow them; `POST /api/push/web-test`, sent while signed in, delivers a test notification to that person.
3. **OwnerIQ**: hand over to `/connect-owneriq`.
4. **AI (`ANTHROPIC_API_KEY`)**: set a monthly spend limit in the Anthropic Console first. Check: generate an AI report on a person.
5. **Photo storage (`CI_S3_*`)** and **badge background removal (`REPLICATE_API_TOKEN`)** when they start making badges.

## When you finish

Tell them in a few lines: the live address; what's switched on; what's optional and still off; next steps (`/brand`, `/connect-owneriq`); and the day-to-day routine from `docs/SETUP.md`: pay rates, targets, training content and the timetable are changed in the app; anything else goes through Claude Code, then the checks, then a push.
