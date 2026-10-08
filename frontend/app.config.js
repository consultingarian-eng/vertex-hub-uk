// Expo config. The real configuration still lives in app.json — this file only
// exists to vary ONE field by environment, and passes everything else through
// untouched.
//
// Why: a hosted Metro dev server (a Dockerfile that sets EXPO_WEB_SPA=1) exists
// purely so a native dev client can load the bundle. It has no reason to
// render the web app, but `web.output: "static"` makes expo-router build a
// second, server-rendering module graph on top of the client one. Any plain
// HTTP GET to `/` — a crawler, an uptime check, a mistyped URL — makes that dev
// server bundle ~2200 modules twice in a single Node process, which is what
// put it over the heap limit and crashed it.
//
// Setting `output: "single"` there drops the server-render graph and leaves a
// plain SPA shell, which is all that URL should ever serve to a browser anyway.
//
// The production web build MUST keep "static" — the backend image runs
// `npx expo export --platform web` and serves the result — so this is gated on
// an env var only that dev-server image sets. With EXPO_WEB_SPA unset the
// resolved config is identical to app.json, which is verified in
// tests/test_app_config_web_output.py.
//
// Native builds: app.json carries no Expo account linkage (no owner, EAS
// projectId or EAS Update URL — Vertex Hub ships as an installed web app). To
// build natively, run `eas init` (adds owner + extra.eas.projectId to
// app.json) and, for over-the-air updates, `eas update:configure` (adds
// updates.url; set updates.enabled back to true).
const { expo } = require('./app.json');

module.exports = () => {
  if (process.env.EXPO_WEB_SPA !== '1') return expo;
  return { ...expo, web: { ...expo.web, output: 'single' } };
};
