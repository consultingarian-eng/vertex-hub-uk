---
name: connect-owneriq
description: Connect the owner's copy of the app to their OwnerIQ account, following docs/OWNERIQ.md - runs a read-only login and company check, explains the pins and settings, gets the OWNERIQ_* variables onto Railway without echoing the password, links people by badge number or email, verifies each screen fills in, and explains what syncs when and what OWNERIQ_WRITES_ENABLED would change. Use when the owner asks to connect or set up OwnerIQ, when Field KPIs, Live Operations, the Performance Hub or Bells auto-fill are empty, when people show as unlinked, or when they ask about OwnerIQ write-back.
argument-hint: "[optional: check | link | writes | troubleshoot]"
---

# Connect OwnerIQ

Follow `docs/OWNERIQ.md`. Read it now, in full. It's the source of truth for every setting, the sync schedule and the errors. If the code (`backend/owneriq_*.py`, `backend/routes/owneriq.py`, the jobs in `backend/server.py`) disagrees with the doc, trust the code, tell the owner, and fix the doc.

If `$ARGUMENTS` is `check`, `link`, `writes` or `troubleshoot`, jump to that part. Otherwise go in order, one step at a time, checking each before moving on.

## Ground rules

- **Read-only until they say otherwise.** Never set `OWNERIQ_WRITES_ENABLED`, never call `/api/owneriq/rep-action` without `dry_run`, never call `/api/owneriq/reconcile?dry_run=false`, and never run anything in `backend/owneriq_write.py` for real, unless the owner explicitly asks in this conversation after you've explained what it changes (section 6).
- **The password never appears in the chat.** Don't ask them to paste it to you. The check script asks for it with hidden typing; on Railway they paste it into Variables themselves. Refer to the email by its first 4 characters only.
- **No OwnerIQ login in `backend/.env`.** A local server would start the hourly sync. The check script doesn't need it.
- **You have no admin session on their app.** Never try to call the app's admin endpoints (`POST /api/owneriq/sync`, `/performance/sync`, `/reconcile`) yourself: they need a logged-in admin and you have none. Tell the owner which button to press or that the scheduled job will run it, and ask what they see.
- **Their people's names are personal data.** Output from `--roots` or `/api/owneriq/link-debug` stays in the conversation: never write it into files, commits or docs.

## 1. What they need

Confirm: the app is live on Railway and they can log in as super-admin (otherwise run `/setup` first); they have their OwnerIQ **owner** email and password (the owner-iq.ai dashboard login, not a BA's); their BAs' badge numbers are in OwnerIQ.

## 2. Read-only check

Explain in one sentence: "This logs in to OwnerIQ the way the app will, lists the companies (offices) your login can see, and changes nothing."

They run it **in their own terminal** (it asks for the password with hidden typing, which doesn't work through your tool), from the repo folder:

```
python3 .claude/skills/connect-owneriq/check_owneriq.py
```

Windows: `py -3 .claude\skills\connect-owneriq\check_owneriq.py`. If their account is on a non-default host, they set `OWNERIQ_API_BASE` in that same terminal first: Mac `export OWNERIQ_API_BASE="https://example.owner-iq.ai"`, Windows PowerShell `$env:OWNERIQ_API_BASE = "https://example.owner-iq.ai"` (using the address OwnerIQ support gave them). Ask them to paste the output back (it contains no secrets), then explain it using the table in section 2 of `docs/OWNERIQ.md`:

- **One company:** no pins needed.
- **Several:** agree which to sync (`OWNERIQ_MC_PINS`) and, if the OwnerIQ company names don't exactly match their app office names, write `OWNERIQ_OFFICE_PINS` with their app office names (check them in Admin → Offices).
- **Login failed:** wrong password, not an owner login, or another API host. Fix before going on.
- **The "live ops" column:** the Performance Hub screen shows the first company with "yes". Mention it if they have several.

Only if they want to check owner detection, or the people sync is picking the wrong owner: `--roots` (explain it lists their top-of-tree accounts with names, in their terminal only). Suggest `OWNERIQ_ROOT_USER_IDS` only for top-level accounts that aren't an office owner.

## 3. Set the variables on Railway

Give them the exact block to paste into Railway → Variables → Raw Editor: `OWNERIQ_EMAIL`, `OWNERIQ_PASSWORD` (they type the real value there), plus only the optional lines step 2 showed they need. **Not** `OWNERIQ_WRITES_ENABLED`. Then **Update Variables** and **Deploy**.

If the Railway CLI is linked and they'd like you to set the non-secret ones, `railway variables --set "OWNERIQ_MC_PINS=…"` is fine; the password they set themselves.

Check: in the Railway logs after the deploy, the hourly job no longer says `OwnerIQ sync skipped`. The first run happens within the hour; step 5 forces one sooner.

## 4. Link people

Explain the linking order (stored link → same email → badge number). A matching name never links anyone (people can rename themselves); link-debug's `name_in_app` only says whose badge number to add. Ask them to add badge numbers in **Admin → Users →** each person's card **→ Badge number**, exactly as OwnerIQ shows them. Emails that match in both systems link by themselves within the hour.

## 5. Verify, screen by screen

Walk through section 5 of `docs/OWNERIQ.md` with them:

1. **Field KPIs** (`/field-kpis`): the owner taps **Sync now** (or pulls down) as an Admin; only Admins can trigger a sync, up to 14 days, once a minute. Yesterday's and today's numbers appear.
2. **Live Operations**: sectors appear once teams are out. A Coach or BA only sees teams once their account is linked by id (badge, email or stored link); a matching name is never enough.
3. **Performance Hub**: fills after the first hourly scheduled run. There is no in-app button for it, so tell the owner to wait for the next hour (Sync now on Field KPIs only does the door figures).
4. **Profile → OwnerIQ Sync → Check alignment** (owner/super-admin only; the owner taps it): the dry run. Explain the list: who would change, and the mismatches that need settling by hand. A long list on day one is normal.
5. If people are unlinked: the owner opens `https://<their app>/api/owneriq/link-debug` in their own logged-in browser and tells you what it shows (counts and badge numbers; names stay in the conversation). Compare badge numbers.

For each, tell them what you expected, what they saw, and what it means. Explain the schedule in plain words from "What flows where, and when": hourly KPIs, Performance Hub and Bells; every 10 minutes the Timeline; 03:00 Live Operations re-settle; 04:30 people sync; Live Operations and the Hub fetched live with short caches.

## 6. Writes (only when they ask)

Explain "Writing back to OwnerIQ" from the doc: the table of what each app action does in OwnerIQ, that the people sync only moves **changes** (not pre-existing differences), that owner and admin accounts are never touched, and that every write is logged in `owneriq_write_log`.

Turn it on only when all are true: they've asked; everyone is linked; **Check alignment** shows what they expect; mismatches are settled by hand. Then they set `OWNERIQ_WRITES_ENABLED=true` on Railway and deploy, and you help them read the first `OwnerIQ two-way sync: pulled=… applied=…` log line. To stop: remove the variable and deploy.

## 7. Troubleshoot

Use the "Common errors" table in `docs/OWNERIQ.md`. Read Railway logs for lines containing `OwnerIQ` (the owner pastes them, or you use the Railway CLI if it is linked). Ask for the exact error text; find the cause in `backend/owneriq_*.py` before changing anything. OwnerIQ's API isn't a published public API: if OwnerIQ changed something on their side, say so plainly and propose the smallest code fix, with a test.

## When you finish

Summarise in a few lines: which companies sync and how offices map; how many people are linked (a count, no names); writes on or off; which screens now fill in; and what to watch in the first week (unlinked people, the £12/£15+ split on auto-filled Bells days).
