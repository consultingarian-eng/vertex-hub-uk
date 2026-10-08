# Frontend

The app people use: Expo Router (React Native), shipped as an installable web app. It isn't deployed on its own: the root `Dockerfile` runs `npx expo export --platform web` and the backend serves the result, so the app and the API share one address. Setup and deployment are in [`docs/SETUP.md`](../docs/SETUP.md).

## Where things are

| Path | What |
| --- | --- |
| `app/` | Screens, one file per route (Expo Router). `app/(tabs)/` holds the main tabs |
| `app/_layout.tsx` | Root layout: fonts, theme, auth, the stack of screens |
| `app/+html.tsx` | The web page shell: title, PWA tags, status-bar colour |
| `src/api/client.ts` | Every call to the backend (`/api/...`) |
| `src/theme/brand.ts` | **Brand**: app and organisation names, palette, gradients, fonts |
| `src/theme/ThemeContext.tsx` | Light and dark themes built from `brand.ts` (`useColors()`) |
| `src/utils/appTime.ts` | Time zone, locale (`en-GB`) and currency (`GBP`) |
| `src/nav/`, `src/customization/tabRegistry.ts` | Sidebar, top tabs, phone tab bar, and the customisable list of items |
| `src/components/` | Shared components (Performance Hub, Live Operations, Bells, badges, schedule, spider diagram, …) |
| `public/` | PWA `manifest.json`, the service worker `sw.js` (web push) and the home-screen icons |
| `assets/` | Images, fonts, badge template |

Rebranding touches `src/theme/brand.ts`, `public/`, `assets/`, `app.json` and `app/+html.tsx`: see [`docs/BRANDING.md`](../docs/BRANDING.md).

## Run it locally

With the backend running on port 8000 ([`docs/SETUP.md`](../docs/SETUP.md), step 5), create `frontend/.env` with:

```
EXPO_PUBLIC_BACKEND_URL=http://localhost:8000
```

Then:

```
npx --yes yarn@1.22.22 install
npx expo start --web --port 8081
```

Open http://localhost:8081.

## Checks

```
npx tsc --noEmit
EXPO_PUBLIC_BACKEND_URL="" npx expo export --platform web
```

The second is the same build the Dockerfile runs; an empty backend URL makes the app call its own `/api`.

## Build-time settings

| Variable | What |
| --- | --- |
| `EXPO_PUBLIC_BACKEND_URL` | Where the app finds the API. Empty in production (same address); `http://localhost:8000` locally |
| `EXPO_PUBLIC_APP_TIMEZONE` | Time zone for the screens, default `Europe/London`. Keep it in step with the backend's `APP_TIMEZONE` |
| `EXPO_WEB_SPA` | Only for a hosted Metro dev server; leave unset. See `app.config.js` |

These are baked in at build time, not read at run time.

## Native builds (not set up)

The app ships as a web app, so `app.json` deliberately has no Expo account linkage: no `owner`, no `extra.eas.projectId`, no `updates.url`, and `updates.enabled` is `false`. To build iOS/Android apps with your own Expo account:

1. Set your own `ios.bundleIdentifier` and `android.package` in `app.json` (e.g. `uk.co.yourorg.hub`).
2. Run `eas init` in this folder, then `eas build`.
3. For over-the-air updates, run `eas update:configure` and set `updates.enabled` back to `true`.

Native builds receive notifications through Expo's push service; the web app uses web push (VAPID keys on the backend).
