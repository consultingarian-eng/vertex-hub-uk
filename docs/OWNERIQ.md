# Connecting OwnerIQ

OwnerIQ (Field IQ's owner dashboard at [owner-iq.ai](https://owner-iq.ai)) is where your BAs' door-by-door numbers live. Connect it and the app fills itself in: Field KPIs, Live Operations, the Performance Hub, the Timeline, Bells sign-ups and goals, and the stages on the spider diagram. Without it the app still works, but those screens stay empty and Bells is typed in by hand.

The app uses your OwnerIQ **owner login** to read the same data the OwnerIQ website shows you. By default it only reads. Writing back to OwnerIQ (stages, deactivations, coach lines, teams) stays off until you switch it on.

> **With Claude Code:** type `/connect-owneriq`. It walks you through this page, runs the read-only check below for you, and explains what it finds.

## Contents

1. [Before you start](#1-before-you-start)
2. [Check your login (read-only)](#2-check-your-login-read-only)
3. [Set the variables on Railway](#3-set-the-variables-on-railway)
4. [Link your people](#4-link-your-people)
5. [Check it worked](#5-check-it-worked)
6. [Every setting explained](#every-setting-explained)
7. [What flows where, and when](#what-flows-where-and-when)
8. [Writing back to OwnerIQ](#writing-back-to-owneriq-owneriq_writes_enabled)
9. [When OwnerIQ isn't connected](#when-owneriq-isnt-connected)
10. [Common errors](#common-errors)

## 1. Before you start

You need:

- The app already running on Railway, with you able to log in as the super-admin ([SETUP.md](SETUP.md)).
- Your OwnerIQ **owner** email and password: the ones you use at owner-iq.ai to see your office's dashboard. A BA or coach login won't do.
- Your BAs' **badge numbers** exactly as OwnerIQ shows them (OwnerIQ → the people list). The app matches people by badge number or by email address.

A dedicated owner login just for the app is a good idea if OwnerIQ will give you one: you can change its password without logging yourself out everywhere.

## 2. Check your login (read-only)

Before you put anything on Railway, prove the login works and find your company pins. From the repo folder, in a terminal (Mac: Terminal; Windows: PowerShell):

```
python3 .claude/skills/connect-owneriq/check_owneriq.py
```

(On Windows: `py -3 .claude\skills\connect-owneriq\check_owneriq.py`.) Python 3.11 or newer is fine.

If your account is on a different OwnerIQ host (OwnerIQ support will tell you), set `OWNERIQ_API_BASE` in that same terminal window first, with the address they gave you in place of the example: Mac `export OWNERIQ_API_BASE="https://example.owner-iq.ai"`, Windows PowerShell `$env:OWNERIQ_API_BASE = "https://example.owner-iq.ai"`. It lasts only for that window.

It asks for your OwnerIQ email and password (the password is typed hidden and never printed), logs in exactly as the app does, and lists every **marketing company** your login can see: its id, its **pin** and its name. It also prints ready-to-paste `OWNERIQ_MC_PINS` and `OWNERIQ_OFFICE_PINS` lines. It changes nothing in OwnerIQ and doesn't touch your database. It only needs Python, nothing else installed.

What it means:

| You see | Meaning |
| --- | --- |
| `OK logged in` and one company | Simplest case. You don't need `OWNERIQ_MC_PINS` or `OWNERIQ_OFFICE_PINS` at all |
| Several companies | You manage more than one office in OwnerIQ. Decide which ones this app should sync (step 3) |
| `Login failed (HTTP 401)` or similar | Wrong email/password, not an owner login, or your account is on another API host (see `OWNERIQ_API_BASE`) |
| `Could not reach …` | No internet, or a wrong `OWNERIQ_API_BASE` |

**Finding the pins without the script.** In the OwnerIQ web app, the company switcher lists your marketing companies; each has a pin. The script is quicker and can't mistype them.

**Do I need `OWNERIQ_ROOT_USER_IDS`?** Usually not. Run the script with `--roots` to see the accounts at the very top of your OwnerIQ tree for each company, with how many people report to each. The app treats the top account with the most reports as that office's owner. If an account that is *not* an office owner sits up there (an agency or platform account, say) and might out-rank you, put its id in `OWNERIQ_ROOT_USER_IDS`. `--roots` lists your people's names in your terminal, so don't paste its output anywhere public.

## 3. Set the variables on Railway

Railway → your service → **Variables** → **Raw Editor**, add:

```
OWNERIQ_EMAIL=<your OwnerIQ owner email>
OWNERIQ_PASSWORD=<your OwnerIQ password>
```

Then only what you need:

```
OWNERIQ_MC_PINS=<pins to sync, comma-separated>          # only if you don't want every company
OWNERIQ_OFFICE_PINS=<Office Name=PIN,Other Office=PIN>   # only with 2+ companies whose names differ from your app offices
OWNERIQ_API_BASE=<host>                                  # only if OwnerIQ told you your account is on another host
```

Leave `OWNERIQ_WRITES_ENABLED` unset for now. Click **Update Variables**, then **Deploy** on the banner (Railway holds variable changes until you deploy).

Never put the password in `backend/.env` on your computer: a local server would start the same hourly sync as production.

## 4. Link your people

Each OwnerIQ person is linked to an app account in this order:

1. A link the app already made (stored on the account).
2. The same **email address** in both systems (checked every hour).
3. The **badge number**: in the app, **Admin → Users →** the person's card **→ Badge number → Add badge number**. Enter it exactly as OwnerIQ has it (letters, numbers and dashes; several separated by commas).
Making someone's ID badge in the **Badge Studio** also adds its number for them, but only when you make it from that person's own page (**Admin → Users →** tap their name **→ Badge**); a badge made in the studio without starting from a person is saved unlinked. One badge number can belong to only one person: the app refuses a number someone else already holds.
A matching **name** never links anyone: people can change their own display name, so a name only shows up as a hint (`name_in_app` on the link-debug page below) telling you whose badge number to add. Until a person is linked by one of the three above, their OwnerIQ figures count in the office totals but not on their own screens.

Your own super-admin account is linked to the OwnerIQ owner login automatically. Once linked, a person stays linked.

Links decide who sees what. A Coach sees a team in Live Operations or the Performance Hub because their linked OwnerIQ id is in it (or it's led by someone under them in the app), never because a name matches. A Coach or BA who isn't linked yet sees no live teams until they are.

## 5. Check it worked

After the deploy finishes:

1. Open **Field KPIs** (go to `/field-kpis`, or pin **KPIs** to your sidebar from **Customise**) and, as an Admin, tap **Sync now** (or pull down to refresh). You should see doors, spoken to, presented, closed and sign-ups for yesterday and today, and when it last synced.
2. **Live Operations** shows today's sectors once your teams are out (it's empty before the first knock).
3. **Performance Hub** (Admins and Coach+) fills in after the first hourly run. There is no button for it in the app: the scheduled job runs it every hour, so wait for the top of the hour (the first run after your deploy). **Field KPIs → Sync now** pulls the door figures only, not the Hub. Claude Code can't trigger the Hub sync for you, because it has no admin session on your app.
4. **Profile → OwnerIQ Sync → Check alignment** (the owner, i.e. the super-admin, only: it covers every office). This is a dry run: it lists the differences between OwnerIQ and the app (who is active, who coaches whom, who is a Coach) and changes nothing. A long list on day one is normal.

If people show as unlinked, an admin can open `https://<your app>/api/owneriq/link-debug` in the browser while logged in (this is a page you open yourself, not something for Claude Code to call): it shows how many badge numbers the app holds and samples of OwnerIQ rows that didn't match, for the admin's own office (the owner sees every office). `name_in_app: true` means an app account has that name but no badge link yet: add the badge number.

## Every setting explained

| Variable | Required? | What it does | Where to get it |
| --- | --- | --- | --- |
| `OWNERIQ_EMAIL` | Yes, for any OwnerIQ feature | The owner login the app signs in with | Your OwnerIQ account |
| `OWNERIQ_PASSWORD` | Yes, for any OwnerIQ feature. **Secret: set your own; no default** | Its password | Your OwnerIQ account |
| `OWNERIQ_API_BASE` | No. Default `https://us.owner-iq.ai` | The OwnerIQ API host | OwnerIQ support, if your account isn't on the default host |
| `OWNERIQ_MC_PINS` | No. Blank = every company the login can see | Which marketing companies (offices) to sync, comma-separated pins | The check script, or OwnerIQ's company switcher |
| `OWNERIQ_OFFICE_PINS` | No | Which OwnerIQ company each app office is: `Office Name=PIN,Other=PIN`. Office names are matched ignoring capitals | You choose; the check script suggests a line |
| `OWNERIQ_ROOT_USER_IDS` | No | Top-of-tree OwnerIQ accounts that are *not* an office owner, skipped when the people sync looks for each office's owner | `check_owneriq.py --roots` |
| `OWNERIQ_WRITES_ENABLED` | No. Default off | Lets the app change things in OwnerIQ and lets the people sync apply changes. See below | `true` when you're ready |
| `OWNERIQ_LIVE_TTL` | No. Default `60` | Seconds today's Live Operations data is reused before OwnerIQ is asked again | Raise it if you ever hit OwnerIQ rate limits |
| `ROSTER_SHARE_TOKEN` | No. **Secret: set your own; no default** | Turns on a no-login page at `/public/roster/<token>` comparing OwnerIQ's active reps with active app accounts, per office. Anyone with the link can use it. At least 32 characters, or the page stays off; wrong links from one address are blocked after 10 tries in 15 minutes | Mac `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`, Windows `py -3 -c "import secrets; print(secrets.token_urlsafe(32))"` |

**How offices map to companies.** For each app office the app uses, in order: an `owneriq_pin` field on the office record (if someone set one in the database), then `OWNERIQ_OFFICE_PINS`, then "there's only one company, so it's that one", then a company whose OwnerIQ name exactly matches the office name. An office that matches none of these has no OwnerIQ data.

## What flows where, and when

All times are UK time (`APP_TIMEZONE`). Nothing runs until `OWNERIQ_EMAIL` and `OWNERIQ_PASSWORD` are both set.

| When | What | Direction |
| --- | --- | --- |
| **Every hour** | **KPI sync:** yesterday's and today's door figures per BA (doors, spoken to, pitches started, pitches closed, sign-ups, points), for every company synced. Re-reading yesterday picks up OwnerIQ's same-day corrections | OwnerIQ → app |
| Every hour, straight after | **Performance Hub sync:** this week and last week: each BA's weekly target and goal status, daily attendance and sign-ups, team names and leaders. Weekly goals go into Bells **unless someone typed a goal in the app**, which then always wins. Days nobody has filled in on Bells get the BA's OwnerIQ sign-ups as £12 sign-ups, flagged so a coach can correct the £12/£15+ split; once someone edits a day the sync leaves it alone. Also refreshes everyone's OwnerIQ stage for the spider diagram | OwnerIQ → app |
| Every hour, straight after | **People sync:** compares who is active, who coaches whom, and who is a Coach (stage 3 and up) on both sides. With writes **off** it only works out the differences; nothing changes on either side | Both ways, only with writes on |
| **Every 10 minutes** | **Timeline:** refreshes today's door logs between 10:00 and 22:00, and fills in one missing past day at a time, back eight weeks. Then the "two zeroes in a row" check, which sends one "Retrain needed" alert per person to the Owner and their Coaches | OwnerIQ → app |
| **03:00 daily** | **Live Operations re-settle:** re-reads yesterday's whole Live Operations tree once, so late corrections replace the cached copy | OwnerIQ → app |
| **04:30 daily** | **People sync** again (the safety net) | Both ways, only with writes on |
| When someone opens a screen | **Live Operations** (sectors → sector → BA door log) is fetched live: today's data is reused for `OWNERIQ_LIVE_TTL` seconds; finished days are kept for good. **Performance Hub** views are reused for 3 minutes for the current week and 6 hours for settled weeks; if OwnerIQ can't be reached the last copy is shown, marked stale | OwnerIQ → app |
| When an **Admin** refreshes **Field KPIs** (or the Home field averages card) | A KPI sync of at most the last 14 days of the range shown, at most once a minute for the whole app. Coaches and BAs refreshing just re-read what the hourly sync stored | OwnerIQ → app |

**Notes**

- OwnerIQ doesn't split £12 and £15+ sign-ups, which is why Bells fills in £12 and asks coaches to correct it.
- OwnerIQ can't take a goal or a sign-up back from the app, so goals typed in the app stay in the app.
- With several companies, the KPI sync, Live Operations and Bells cover all of them. The **Performance Hub screen** shows one company: the first one OwnerIQ lists for your login.
- Who sees what is decided on the server: Admins and Coach+ see the whole office in Live Operations, the Performance Hub and Field KPIs; a Coach sees their own team; a BA sees their own numbers.

## Writing back to OwnerIQ (`OWNERIQ_WRITES_ENABLED`)

Off by default. While it's off, the app never changes anything in OwnerIQ, the people sync only reports differences, and the buttons that would write (below) answer "OwnerIQ writes are off".

With `OWNERIQ_WRITES_ENABLED=true` these start writing to OwnerIQ:

| In the app | In OwnerIQ |
| --- | --- |
| An admin makes a BA a Coach | Their stage is raised to stage 3 |
| A person is removed from the app | Deactivated; a team they led is deleted |
| A Coach names or renames their team | The team is created or renamed |
| A BA is assigned to a Coach | Moved under that Coach in the OwnerIQ tree |
| Spider diagram: **Advance**, **Demote**, **Remove**, or dragging someone onto a Coach (Admins) | Stage up/down, deactivate, or move under that Coach |
| **Profile → OwnerIQ Sync → Apply** | Applies the differences "Check alignment" listed |
| The hourly and 04:30 people sync | Changes made in the app are sent to OwnerIQ; changes made in OwnerIQ (deactivations, coach moves, stage 3 and up) are copied into the app |

The people sync only moves **changes**: something that changed on one side since its last run. A difference that was already there when it first ran (or that changed on both sides) is listed under mismatches for you to settle by hand; it is never "fixed" automatically. Your own owner account and other admin accounts are never moved or re-staged. Every write is logged in the `owneriq_write_log` collection.

**Turning it on safely**

1. Link everyone (step 4) and run **Check alignment** until the list is what you expect.
2. Settle the mismatches by hand, in OwnerIQ or in the app.
3. Set `OWNERIQ_WRITES_ENABLED=true` on Railway and deploy.
4. Watch the first hourly run in Railway's logs (`OwnerIQ two-way sync: pulled=… applied=…`).

To stop all writes at once, delete the variable (or set it to `false`) and deploy.

**Who can trigger what** (checked on the server):

- `POST /api/owneriq/sync` (manual KPI sync): Admins only, a range of at most 14 days, and one run a minute across the whole app. Missing dates are filled in first (to = today, from = the day before) and a `to_date` after today is pulled back to today, so the 14-day cap always applies to what is really pulled. The scheduled hourly sync is unaffected.
- `POST /api/owneriq/performance/sync`: Admins, sharing the same one-a-minute slot. `bells_weeks` (re-fill Bells from OwnerIQ for earlier weeks) is up to 2 for an Admin; up to 8 is the owner's backfill tool.
- `POST /api/owneriq/reconcile` (Check alignment / Apply): the owner (super-admin) only, because it covers every office. `dry_run=false` also needs `OWNERIQ_WRITES_ENABLED`.
- `POST /api/owneriq/rep-action` (the spider diagram's Advance / Demote / Remove / move): an Admin may only act on people in their own office, named by their app account (`cg1_user_id`); the new Coach in a move must be in the same office. Targeting a raw OwnerIQ id (`owneriq_user_id`, digits only) is for the owner only. Anything not a dry run needs `OWNERIQ_WRITES_ENABLED`.
- Every write function in `backend/owneriq_write.py` checks `OWNERIQ_WRITES_ENABLED` itself, so no new caller can write while it's off, and OwnerIQ ids are accepted as digits only.

## When OwnerIQ isn't connected

Nothing breaks. Specifically:

- **Field KPIs** and the Home field cards show no numbers.
- **Live Operations** says *"OwnerIQ isn't connected on this copy of the app, so only days already saved can be shown."*
- **Performance Hub** says *"OwnerIQ isn't connected yet."*
- **Bells** works normally; everything is typed in by people.
- **Timeline** only has days already saved.
- The scheduled jobs log "OwnerIQ sync skipped" and carry on.

## Common errors

| What you see | Likely cause | Fix |
| --- | --- | --- |
| Logs: `OWNERIQ_EMAIL / OWNERIQ_PASSWORD not configured` | Variables missing, or added but not deployed | Add both and click **Deploy** on Railway's banner |
| Logs or screen: `login failed: HTTP 401` (or 422) | Wrong password, not an owner login, or another API host | Run the check script; ask OwnerIQ support for your host and set `OWNERIQ_API_BASE` |
| `select company <pin> failed` | A pin in `OWNERIQ_MC_PINS` that this login can't see | Re-run the check script and copy the pins it lists |
| Numbers appear in OwnerIQ but not for a person in the app | That person isn't linked | Add their badge number exactly as OwnerIQ has it, or make the emails match; check `/api/owneriq/link-debug` |
| An office shows nothing, another office's figures appear in it, or the office switcher shows "Office 12345" | Office-to-company mapping | Set `OWNERIQ_OFFICE_PINS` with your app office names |
| "No Performance Hub data for that week yet." | The hourly run hasn't happened yet, or the week has no data | Wait for the next hourly run (there's no button for it in the app) |
| "You weren't in a team in OwnerIQ that week…" (a Coach) | That Coach doesn't lead a named team in OwnerIQ for that week | Name the team in OwnerIQ (or, with writes on, in the app's Profile) |
| "OwnerIQ writes are off…" | `OWNERIQ_WRITES_ENABLED` isn't on | Expected. Turn it on only when you're ready (above) |
| `OwnerIQ could not be reached. Try again in a moment.` | OwnerIQ slow or down | Wait; the last saved copy is still shown where there is one |

OwnerIQ's API isn't a published public API: the app talks to it the way the OwnerIQ website does. If OwnerIQ changes something on their side, a screen can stop filling in until the code is updated. Paste the exact error from Railway's logs to Claude Code and ask it to find the cause in `backend/owneriq_*.py` before changing anything.

## Where it lives in the code

| File | What it does |
| --- | --- |
| `backend/owneriq_sync.py` | Login, the hourly KPI sync, matching rows to people |
| `backend/owneriq_config.py` | Which companies to sync and how offices map to them |
| `backend/owneriq_performance.py` | Performance Hub sync, Bells goals and fill-in, linking by email/badge, stages |
| `backend/owneriq_hub.py` | The Performance Hub screen's data and caching |
| `backend/owneriq_live.py` | Live Operations, caching, the 03:00 re-settle |
| `backend/owneriq_field.py` | Timeline records from the door logs |
| `backend/owneriq_write.py` | Every write to OwnerIQ, the people sync, `writes_enabled()` |
| `backend/routes/owneriq.py` | The `/api/owneriq/*` endpoints |
| `backend/routes/roster_share.py` | The `/public/roster/<token>` page |
| `backend/server.py` | The schedule (search for `owneriq`) |
