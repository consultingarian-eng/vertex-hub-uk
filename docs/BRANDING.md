# Adding your own branding

The app ships in Vertex Labs' branding: the name "Vertex Hub", a forest-green and lime palette, and an X logo. This page lists every place the brand lives so you can make the app yours: name, logos and icons, colours, fonts, the ID-badge template, emails and printed documents.

> **With Claude Code:** type `/brand`. It asks for your name, colours and logo files, makes every change on this page, rebuilds, and shows you the result before anything goes live.

Your branding must be **yours**. Use your own organisation's name and artwork. For anything carrying a charity's name or logo (most of all the ID badge), use only artwork that charity or your agency has approved for you to use. Never copy another organisation's logo, badge or name, including the Vertex artwork this repo ships with.

## Contents

1. [What you'll need](#what-youll-need)
2. [Names](#1-names)
3. [Logos and icons](#2-logos-and-icons)
4. [Colours](#3-colours)
5. [Fonts](#4-fonts)
6. [The ID badge](#5-the-id-badge)
7. [Emails, the launch page and printed documents](#6-emails-the-launch-page-and-printed-documents)
8. [Rebuild, check and deploy](#7-rebuild-check-and-deploy)
9. [Checklist](#checklist)

## What you'll need

| Item | Format |
| --- | --- |
| App name, e.g. "Northside Hub" | Text, plus a short version of 12 characters or fewer for under the home-screen icon, e.g. "Northside" |
| Organisation name | Text, as it should appear in email footers |
| Your logo mark (a symbol that works small) | A square **SVG**, or a PNG at least 1024 × 1024 with a transparent background |
| Your full logo / wordmark | SVG, or a wide transparent PNG, in a **light** colour (it sits on your dark brand colour) |
| Two or three brand colours | Hex codes, e.g. `#1d3557`. One dark (surfaces), one accent, one light (page) |
| Optional: fonts | `.ttf` files you're licensed to embed in an app (Google Fonts' open-licence fonts are fine) |
| Optional: badge details | The organisation name and verification phone number for the badge, and (if you have one) your approved badge artwork at 600 dpi |

## 1. Names

The name is set in **two** places, because the server and the app screens are built separately. Change both.

| Where | What to change | Shows up in |
| --- | --- | --- |
| Railway → Variables | `APP_NAME`, `ORG_NAME` (defaults "Vertex Hub" / "Vertex Organisation") | Emails, the `/launch` page, push notifications, AI-written text, the roster page |
| Railway → Variables | `SENDGRID_FROM_NAME` | The sender name in people's inboxes |
| Railway → Variables | `BADGE_ORG_NAME` (optional; defaults to `ORG_NAME`), `BADGE_VERIFY_PHONE` | Printed on the ID badge: who the BA is authorised by, and the number the public can call to check |
| `frontend/src/theme/brand.ts` | `APP_NAME`, `APP_SHORT_NAME`, `ORG_NAME` | Every screen. `APP_SHORT_NAME` also names the team for people not yet in a named team ("Mini …" on Bells), the "… New Starts" card on Home, and badge export titles |
| `frontend/public/manifest.json` | `name`, `short_name`, `description` | The installed app's name on Android and in Chrome |
| `frontend/app/+html.tsx` | `<title>` and `apple-mobile-web-app-title` | Browser tab, and the name under the icon on iPhone |
| `frontend/public/sw.js` | `const APP_NAME` | Title of a notification that arrives without one |
| `frontend/app.json` | `name`, `slug`, `scheme`; and for native builds only `ios.bundleIdentifier` and `android.package` (use your own reversed domain, e.g. `uk.co.yourorg.hub`) | App config. The `expo-audio` microphone message is neutral (nothing in the app records audio yet); reword it if you add a recording feature |

**Names typed straight into the code.** A few screens spell the name out instead of reading `brand.ts`. To find them all:

```
grep -rni vertex backend/routes backend/core backend/seed backend/seed_data.py frontend/app frontend/src frontend/public frontend/app.json
```

Use the **case-insensitive** form (`-i`): some names are lower-case, such as the file names `vertex-document.pdf` and `vertex-badges.pdf` that people see when they save or share a PDF, and the `vertex` wordmark.

Change every one that **people will read**: poster footers in `frontend/app/bulletin.tsx` and `frontend/app/team-bulletin.tsx`, the share title in `frontend/app/share-bulletins.tsx`, the footer of the public Bells page (`frontend/app/public/bells/[office].tsx` and `backend/routes/public_html.py`, which also has the logo's alt text), the default office label in `backend/routes/quality.py`, and the badge export file name in `frontend/src/components/badges/BadgeStudio.tsx`. Better still, make them read `APP_NAME` / `ORG_NAME`.

Other user-visible names that grep finds and that are easy to miss:

- **File names people see:** `vertex-document.pdf` (the default name of a shared or saved PDF, in `frontend/src/utils/deliverPdf.ts`) and `vertex-badges.pdf` (`BadgeStudio.tsx`).
- **"Mini Vertex"**, the Bells team for people not yet in a named team: the on-screen label is built from `APP_SHORT_NAME` in `frontend/src/components/bells/TableView.tsx` (`Mini ${APP_SHORT_NAME}`), so it follows `brand.ts`; the other mentions are code comments. Check Bells after you change it.
- **Earnings Calculator:** the button "Fill in the standard Vertex rates" (`frontend/app/(tabs)/pay.tsx`).
- **The app's own browser tab and PWA names:** the `apple-mobile-web-app-title` "Vertex" in `+html.tsx`, and `short_name` in `manifest.json`.
- **Bulletin posters and the weekly-bulletin banner:** "Vertex Organisation" and "Vertex Hub · Weekly Bulletin" in `bulletin.tsx` and `team-bulletin.tsx`.
- **The public Bells page:** "Shared via Vertex Hub" and the logo's alt text, in both `public/bells/[office].tsx` and `backend/routes/public_html.py`.
- **Starting content:** the Terminology topic ("Everyone at Vertex is self-employed"), the Coaching Guide heading, and the training chain "NDCS → Acwyre → Vertex Organisation → Brand Ambassador" in `backend/seed/*.json` and `backend/seed_data.py`. These only change a brand-new database; on a live one edit them in the app (see [SETUP.md](SETUP.md#step-11--make-it-yours)).
- **Defaults when `ORG_NAME` / `APP_NAME` are unset:** "Vertex Hub" and "Vertex Organisation" in `backend/core/brand.py`.
- **Not shown to anyone** (leave alone): code names, the browser-storage key `vertex.earnings.v2`, and the schedule template id `vertex-week-v1`.

**Leave internal names alone.** File and code names such as `vertexPay.ts`, `vertex_pay.py`, `VertexMark`, `vertexGeometry.ts` and `VertexFees` are never shown to anyone. Renaming them is optional and touches many files. The Earnings Calculator's button "Fill in the standard Vertex rates" refers to the Vertex pay plan; reword it if you change the plan.

## 2. Logos and icons

**Image files.** Replace each file with yours at the **same size and name**:

| File | Size | Used for |
| --- | --- | --- |
| `frontend/assets/images/icon.png` | 1024 × 1024, opaque | App icon (native builds, notification icon) |
| `frontend/assets/images/adaptive-icon.png` | 1024 × 1024, transparent, mark within the middle ~50% | Android adaptive icon. Background colour: `android.adaptiveIcon.backgroundColor` in `app.json` |
| `frontend/assets/images/favicon.png` | 48 × 48 | Browser tab icon |
| `frontend/assets/images/splash-icon.png` | 1242 × 1242, transparent | Splash screen, light mode |
| `frontend/assets/images/splash-icon-dark.png` | 1242 × 1242, transparent | Splash screen, dark mode. Splash background colours are in `app.json` under `expo-splash-screen` |
| `frontend/assets/logo.png` | 1024 × 1024 | Logo on the email-verification screen |
| `frontend/public/icons/icon-192.png` | 192 × 192, opaque | Installed-app icon (Android/Chrome) and notification icon |
| `frontend/public/icons/icon-512.png` | 512 × 512, opaque | Installed-app icon |
| `frontend/public/icons/maskable-512.png` | 512 × 512, opaque, mark within the middle ~55% | Android crops this to a circle or rounded shape (the safe area is a central circle 80% wide) |
| `frontend/public/icons/apple-touch-180.png` | 180 × 180, opaque | iPhone/iPad home-screen icon |
| `frontend/public/icons/badge-96.png` | 96 × 96, **white** mark on transparent | Android status-bar notification icon (must be one colour) |
| `backend/assets/logo.png` | About 1370 × 454, transparent, **light** colour | Served at `/api/logo.png`: emails (embedded), `/launch`, the public Bells page, bulletin posters. It always sits on your dark brand colour |
| `backend/assets/icon.svg` | Square SVG | Favicon of the `/launch` page (embedded in the page) |

"Opaque" means a solid background (your dark brand colour is usual): iOS and Android show transparent areas as black or white.

**The logo drawn in code.** The mark in the sidebar, mastheads, the login screen, the splash animation and a few headers isn't an image file. It's drawn by `frontend/src/components/ui/VertexMark.tsx`, which exports `VertexMark` (the symbol, recoloured to suit light and dark themes) and `VertexLogo` (the full lockup), using shapes from `vertexGeometry.ts`. To use your logo:

- **Single-colour SVG logo (best):** replace the shapes inside `VertexMark` and `VertexLogo` with your SVG's paths (they use `react-native-svg`), keeping the same component names and props (`size`, `width`, `color`). Every screen picks it up, and it still recolours for dark mode.
- **PNG or multi-colour logo:** make both components return an `<Image>` of your file, with a light and a dark version chosen by theme. Keep the component names and props so nothing else needs editing.

`frontend/src/components/ui/Decor.tsx` and a few backgrounds use Vertex's halftone-dot motif. Restyle or remove them if they don't suit your brand.

**Not used by the app:** `frontend/assets/brand/*.svg` (Vertex's source artwork) and `frontend/scripts/brand_assets.py` (the script that drew it; it only runs on Windows with Microsoft Edge). Don't confuse it with `frontend/scripts/badge_template.py`, which draws the neutral badge template. Delete them, or keep your own source artwork in that folder instead.

## 3. Colours

**The tokens.** `frontend/src/theme/brand.ts` holds the palette (`brand`) and gradients (`GRADIENT`, `GRADIENT_HERO`, `GRADIENT_INK`, …). `frontend/src/theme/ThemeContext.tsx` builds the light and dark themes from it. Change `brand.ts` first.

The shipped palette, and what each colour does:

| Token | Shipped | Role |
| --- | --- | --- |
| `forest` | `#102d25` | Main dark surface (ink blocks, dark cards, PWA background) |
| `deep` | `#0b211c` | Darkest shade; text on the accent in dark mode |
| `mid` | `#244c3b` | Primary colour on light screens; carries white text |
| `lime` | `#b7df58` (`rgba(183,223,88,…)`) | The accent. Text on it is always dark |
| `limeDark` | `#8caf38` (`rgba(140,175,56,…)`) | Accent for graphics on light backgrounds (not text) |
| `paper` | `#f0f4e9` | Light page background |
| `card` | `#f9faf4` | Light card face |
| `ink` | `#17362b` | Body text on light surfaces |
| `muted` | `#50675a` | Secondary text on light surfaces |
| `rule` | `#cedbc7` | Hairlines on light surfaces |
| `amber` | `#e7b65c` | Warm second accent |
| `sage` / `leaf` | `#b5c8b2` / `#3a7a56` | Muted text on dark / lightest green that still carries white text |
| (page, dark) | `#061410` | Dark-mode page and the iPhone status-bar area (`+html.tsx`, `_layout.tsx`, `ThemeContext.tsx`) |

Status colours (green, yellow, red, grey) are deliberately not brand colours; leave them.

**Colours typed straight into the code.** Many screens, PDF exports and server-rendered pages repeat these hex values instead of reading the tokens. After changing `brand.ts`, find and replace each old value (and its `rgba(…)` form) across:

```
frontend/app  frontend/src  frontend/public/manifest.json  frontend/app.json
backend/core/brand.py  backend/routes
```

`backend/core/brand.py` has the server's own copy of the palette (emails, `/launch`, the public Bells and roster pages). `frontend/src/theme/colors.ts` is an older static copy still imported by a few screens. `manifest.json` (`background_color`, `theme_color`) and `app.json` (adaptive icon, splash, notification colour) have their own. The in-between gradient shades in `brand.ts` (e.g. `#27553f`, `#1c4436`) need picking by eye: darker and lighter steps of your main colours.

**Keep it readable.** The app follows these rules; keep them with your colours:

- Text on the accent colour must be dark (`colors.onPrimary` / `colors.onAccent`), never white, unless your accent is dark.
- Every gradient that carries white text must be dark enough for it: aim for a contrast of at least 4.5 : 1 (check with any online contrast checker).
- Check both themes: Profile has a light/dark switch.

## 4. Fonts

The app bundles Space Grotesk (headings), Inter (body), JetBrains Mono (figures) and Unbounded (mastheads and big numbers) in `frontend/assets/fonts/`.

To change them:

1. Put your `.ttf` files in `frontend/assets/fonts/`.
2. Register them in `useFonts({...})` in `frontend/app/_layout.tsx`.
3. Point the roles in `fonts` in `frontend/src/theme/brand.ts` (`display`, `body`, `mono`, `displayWide`, `displayBlack`, …) at the names you registered. The names must match exactly.

Don't add `fontWeight` to a custom font on web: each weight is its own file, and a `fontWeight` makes the browser fake a bold.

Emails and the `/launch` page use web fonts from Google Fonts, set in `backend/core/brand.py` (`FONT_HEADING`, `FONT_BODY`, `GOOGLE_FONTS_HREF`).

## 5. The ID badge

Badge Studio (Admins and Coach+) prints each BA's ID badge as a strip, front on the left and back on the right, folded down the middle. It lays these onto a template image:

- the BA's **photo, name, ID number and expiry date**;
- your **organisation's name** ("authorised by"), from `BADGE_ORG_NAME` (default `ORG_NAME`);
- your **verification phone number**, from `BADGE_VERIFY_PHONE`;
- the badge's **QR code**, which links to `BADGE_QR_URL_TEMPLATE` with `{badge_number}` filled in (or just carries the badge number).

The template that ships, `frontend/assets/badges/badge-template.png`, is **neutral**: frames, labels and a signature box, with no charity, agency or regulator artwork. It's drawn by `frontend/scripts/badge_template.py` (run `python frontend/scripts/badge_template.py` from the repo root with Pillow installed to redraw it, e.g. in your fonts). With the three settings above, it's a complete badge.

**Using your own approved artwork.** If the charity or agency you fundraise for gives you an approved badge design, use that, and never print badges on another organisation's artwork.

1. Export it as one PNG strip at 600 dpi, the same printed size (192.45 × 60.16 mm), front left, back right, with the photo, name, ID, expiry, organisation, phone and QR areas left blank.
2. Replace `frontend/assets/badges/badge-template.png` (same name, or change the `require(...)` for `TEMPLATE_IMG` in `frontend/src/components/badges/BadgeStudio.tsx`).
3. If the boxes sit in different places, update `FIELD` in `BadgeStudio.tsx`: `photo`, `name`, `id`, `expiry`, `orgSmall`, `orgBig`, `phone` and `qr`, each with `x`, `y` (and `w`, `h`) in millimetres from the top-left corner. If your strip is a different size, change `STRIP_W_MM` / `STRIP_H_MM` too.
4. If your artwork already prints the organisation name or phone number, leave `BADGE_ORG_NAME` / `BADGE_VERIFY_PHONE` matching it (an empty `BADGE_VERIFY_PHONE` prints nothing; the organisation name always falls back to `ORG_NAME`), or remove those fields from the layout.
5. Make a test badge, print it at 100% scale, and check every box lines up.

`REPLICATE_API_TOKEN` turns on automatic photo background removal.

## 6. Emails, the launch page and printed documents

- **Emails** (`backend/core/email_utils.py`): name from `APP_NAME` / `ORG_NAME`, logo from `backend/assets/logo.png` (embedded so it shows even when images are blocked), colours from `backend/core/brand.py`, sender from `SENDGRID_FROM_EMAIL` / `SENDGRID_FROM_NAME`.
- **`/launch`** (`backend/routes/launch.py`): the page you send your team to install the app. Name, logo, `icon.svg` and colours as above.
- **Public Bells page** (`backend/routes/public_html.py`) and **roster page** (`backend/routes/roster_share.py`): palette and logo as above, plus the hard-coded strings listed in section 1.
- **Bulletin posters** (`frontend/app/bulletin.tsx`, `team-bulletin.tsx`): logo from `/api/logo.png`, organisation name in the footer, palette in `frontend/src/utils/bulletinWeek.ts`.
- **Other PDFs** (planner print in `frontend/src/components/planner/printPlanner.ts`, availability in `frontend/src/components/hub/availabilityPdf.ts`): palette values in the files themselves.

There is no separate letterhead template: the bulletin posters and these PDFs are the app's printed documents.

## 7. Rebuild, check and deploy

1. **Look at it locally** (see [SETUP.md](SETUP.md), "Run it on your own computer"): `npx expo start --web` in `frontend/` reloads as you save. Check the login screen, Home, the sidebar, Bells, Earnings, a COD page, Profile, in light **and** dark mode, at phone width.
2. **Check the server pages:** with the backend running, open http://localhost:8000/launch and http://localhost:8000/api/logo.png.
3. **Run the checks** (`npx tsc --noEmit`, the web export, the backend tests: [SETUP.md](SETUP.md)).
4. **Set the variables** (`APP_NAME`, `ORG_NAME`, `SENDGRID_FROM_NAME`, `BADGE_*`) on Railway.
5. **Commit and push.** Railway rebuilds the app and the server from the `Dockerfile`.
6. **On phones:** open apps refresh themselves ("Update ready"). The **home-screen icon and name** are copied when someone installs the app, so to see the new icon they remove it from the home screen and add it again from `/launch`.

## Checklist

- [ ] `APP_NAME`, `ORG_NAME`, `SENDGRID_FROM_NAME` (and `BADGE_ORG_NAME` if different) set on Railway
- [ ] `frontend/src/theme/brand.ts`: `APP_NAME`, `APP_SHORT_NAME`, `ORG_NAME`
- [ ] `manifest.json`, `+html.tsx`, `sw.js`, `app.json`: names (and bundle id / package if you'll ever build natively)
- [ ] `grep -rni vertex` (case-insensitive): every user-visible string changed, including `vertex-document.pdf` and `vertex-badges.pdf`
- [ ] All 11 PNG icons/logos in `frontend/assets` and `frontend/public/icons` replaced at the same sizes
- [ ] `backend/assets/logo.png` (light logo on transparent) and `backend/assets/icon.svg` replaced
- [ ] `VertexMark` / `VertexLogo` draw your logo
- [ ] `brand.ts` palette and gradients changed; old hex and `rgba` values replaced everywhere listed above
- [ ] `backend/core/brand.py` palette changed
- [ ] `manifest.json`, `app.json`, `+html.tsx` colours changed
- [ ] Fonts (optional) registered and mapped
- [ ] `BADGE_ORG_NAME`, `BADGE_VERIFY_PHONE`, `BADGE_QR_URL_TEMPLATE` set; a test badge printed at 100% (or your approved artwork in place with `FIELD` positions checked)
- [ ] Light and dark mode checked at phone width; text on the accent is readable
- [ ] Checks pass; pushed; Railway deploy green
- [ ] `/launch`, an email (use "Forgot password"), a bulletin poster and the installed icon checked on a real phone
