---
name: brand
description: Rebrand the owner's copy of the app with their own name, logo, icons, colours, fonts and ID-badge template, following docs/BRANDING.md. Asks for the brand details and logo files, makes every edit (env names, brand.ts, manifest, service worker, app.json, hard-coded strings, every icon size, the drawn logo, palette tokens and stray hex values, server pages and emails), rebuilds, runs the checks and shows the result before anything is pushed. Use when the owner asks to rebrand, change the app name, logo, icon, colours, fonts or badge design, or to "make it ours".
argument-hint: "[optional: names | logo | colours | fonts | badge]"
---

# Rebrand the app

Follow `docs/BRANDING.md`. Read it now, in full; it lists every file. This skill is the interactive way through it. If the code has moved on from the doc, trust the code, finish the job, and update the doc to match.

If `$ARGUMENTS` names one part (names, logo, colours, fonts, badge), do only that part. Otherwise do them in the order below, checking in after each.

## Ground rules

- **Their brand only.** Use the owner's own name and artwork. For anything carrying a charity's name or logo (above all the ID badge), use only artwork they confirm that charity or their agency has approved for them. Never copy another organisation's logo, badge or name, and don't keep the shipped Vertex artwork in places people will see.
- **Work on a branch** (`git switch -c rebrand`) so the live app is untouched until they're happy.
- **Show, then push.** Nothing is pushed until they've seen it running locally and said yes. Pushing deploys to everyone.
- **Keep internal names.** Don't rename code identifiers (`vertexPay.ts`, `vertex_pay.py`, `VertexMark`, `VertexFees`, …) unless asked: nobody sees them and renames ripple through many files.
- **Never print secrets**; branding needs none.

## 1. Collect the details

Ask for these together, in one short message, with examples:

1. **App name** ("Northside Hub") and a **short name** of 12 characters or fewer for under the home-screen icon ("Northside").
2. **Organisation name** for email footers and the badge "authorised by" line.
3. **Logo files**: a square mark (SVG best; else PNG at least 1024 × 1024, transparent) and, if they have one, a wide wordmark. Ask them to put the files in the repo folder (e.g. `branding/`) and tell you the names. Say whether the mark is a single colour (best: it can recolour for dark mode).
4. **Colours**: a dark colour (surfaces), an accent, and a light page colour, as hex codes. Offer to pick them from the logo if they don't know.
5. **Fonts** (optional): keep the shipped ones unless they have `.ttf` files they're licensed to embed.
6. **Badge details** (optional, later is fine): the organisation name and verification phone number for ID badges, and whether the charity or agency they work with has given them approved badge artwork (most owners use the neutral template that ships).

Confirm back in a short table before editing.

## 2. Names

Follow section 1 of `docs/BRANDING.md`:

- `frontend/src/theme/brand.ts`: `APP_NAME`, `APP_SHORT_NAME`, `ORG_NAME`.
- `frontend/public/manifest.json` (`name`, `short_name`, `description`), `frontend/app/+html.tsx` (`<title>`, `apple-mobile-web-app-title`), `frontend/public/sw.js` (`APP_NAME`), `frontend/app.json` (`name`, `slug`, `scheme`, the `expo-audio` microphone text; `ios.bundleIdentifier` / `android.package` to their reversed domain if they give one).
- Run `grep -rn "Vertex" backend/routes backend/core frontend/app frontend/src frontend/public frontend/app.json` and change every **user-visible** string. Where practical, make hard-coded names read `APP_NAME` / `ORG_NAME` / `APP_SHORT_NAME` instead of typing the new name in. Leave code identifiers and comments that only explain history.
- Tell them to set `APP_NAME`, `ORG_NAME`, `SENDGRID_FROM_NAME` (and `BADGE_ORG_NAME` if different) on Railway → Variables, then **Deploy**. Those are the server's copy of the names.

## 3. Logos and icons

- Generate every PNG in the table in section 2 of `docs/BRANDING.md` at **exactly** its size and file name, from their mark (and wordmark for `backend/assets/logo.png` and the splash images). Use Python with Pillow from the backend venv (`pillow` is in `backend/requirements.txt`). For an SVG source, rasterise it first: check what's available (`rsvg-convert`, `inkscape`, `cairosvg`, a headless browser) and ask before installing anything. Don't use `frontend/scripts/brand_assets.py`: it only draws the Vertex mark, on Windows with Edge.
  - Opaque icons: their mark centred on the dark brand colour, about 70% of the width; `maskable-512.png` with the mark inside the middle ~55%; `adaptive-icon.png` transparent with the mark in the middle ~50%.
  - `badge-96.png`: the mark in **white** on transparent.
  - `backend/assets/logo.png`: the wordmark (or mark + name) in a **light** colour on transparent, about 1370 × 454.
  - `backend/assets/icon.svg`: a square SVG of the mark.
  - Update the colours in `app.json` (adaptive-icon background, splash backgrounds, notification colour).
- **The drawn logo:** update `VertexMark` and `VertexLogo` in `frontend/src/components/ui/VertexMark.tsx` as `docs/BRANDING.md` describes (their SVG paths for a single-colour logo; otherwise an `<Image>` with light and dark versions), keeping the component names and props. Look at `Decor.tsx`'s dot motif and ask whether to keep, restyle or remove it.
- Remove or replace `frontend/assets/brand/*.svg` (Vertex's source artwork) and say so.

## 4. Colours

- Map their colours onto the `brand` tokens in `frontend/src/theme/brand.ts` (see the table in section 3 of `docs/BRANDING.md`): dark → `forest` / `deep` / `mid`, accent → `lime` / `limeDark`, light → `paper` / `card`, and derive `ink`, `muted`, `rule`, `sage`, `leaf` and the gradient stops as darker and lighter steps. Keep the status colours.
- Then replace every old value across the places the doc lists, with a small script that maps old → new **case-insensitively**, covering the `rgba(r,g,b,…)` forms too (e.g. lime `183,223,88`, limeDark `140,175,56`, amber `231,182,92`) and the dark page `#061410`. Show them the mapping table first. Include `backend/core/brand.py`, `frontend/src/theme/colors.ts`, `manifest.json`, `app.json` and `+html.tsx`.
- **Contrast check:** compute the contrast ratio for text on the accent (`onPrimary` / `onAccent`), body text on the page and card, and white text on each gradient's lightest stop. Fix anything under 4.5 : 1 by adjusting shades, and tell them what you changed.

## 5. Fonts (optional)

Section 4 of `docs/BRANDING.md`: add the `.ttf` files, register them in `useFonts` in `frontend/app/_layout.tsx`, point the `fonts` roles in `brand.ts` at them. Optionally change the email fonts in `backend/core/brand.py`.

## 6. Badge (optional)

Section 5 of `docs/BRANDING.md`. The shipped template is neutral and the studio prints the organisation name, verification phone and QR from `BADGE_ORG_NAME`, `BADGE_VERIFY_PHONE` and `BADGE_QR_URL_TEMPLATE`, so for most owners this is just those three Railway variables (they set them; offer the exact lines). Optionally redraw the neutral template in their fonts with `python frontend/scripts/badge_template.py`.

Only if they have their own approved badge artwork: ask them to confirm it's approved by the charity or agency, replace the template image, adjust `FIELD` (and `STRIP_W_MM` / `STRIP_H_MM` if the size differs) in `BadgeStudio.tsx` from their measurements, and ask them to print a test badge at 100% and check every box lines up.

## 7. Check and show

1. Run the checks: `cd frontend && npx tsc --noEmit`, `EXPO_PUBLIC_BACKEND_URL="" npx expo export --platform web`, and the backend tests (`CLAUDE.md` has the exact commands).
2. Run it locally (`docs/SETUP.md` step 5) and ask them to look at: login, Home, the sidebar, Bells, Earnings, a COD page, Profile, in **light and dark** mode, at phone width; and http://localhost:8000/launch and http://localhost:8000/api/logo.png.
3. `grep -rni "vertex" frontend/public frontend/app.json frontend/app/+html.tsx backend/assets` should find nothing user-visible.
4. Walk the checklist at the end of `docs/BRANDING.md` and tick what's done.

## 8. Ship it

When they say yes: `git status` (no `.env` files), commit on the branch, merge to `main`, push. Remind them to:

- set the Railway name variables if not done, and **Deploy**;
- check `/launch`, an email ("Forgot password"), a bulletin poster and the installed icon on a real phone;
- re-add the app to the home screen to see the new icon and name (the icon is copied at install).
