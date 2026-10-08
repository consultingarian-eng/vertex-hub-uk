// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en" style={{ height: "100%" }}>
      <head>
        <meta charSet="utf-8" />
        <title>Vertex Hub</title>
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/* maximum-scale=1 stops iOS Safari from auto-zooming IN when you
            focus a sub-16px input (the annoying "page jumps in when I start
            typing"). It only caps zoom-in; zoom-OUT (minimum-scale, unset →
            default 0.25) still works, and iOS 10+ preserves manual pinch-zoom
            for accessibility. So the user keeps pinch-zoom but loses the
            unwanted focus zoom. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />

        {/* PWA: installable "Vertex Hub" home-screen app (Vertex icon, standalone,
            no browser chrome). iOS reads the apple-* tags + apple-touch-icon;
            Android/Chrome reads the web manifest. No push (web can't). */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#061410" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Vertex" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-180.png" />
        {/*
          Disable body scrolling on web to make ScrollView components work correctly.
          If you want to enable scrolling, remove `ScrollViewStyleReset` and
          set `overflow: auto` on the body style below.
        */}
        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              /* Fill the safe areas (status bar above, home indicator below)
                 with the page field colour so the whole screen reads as one
                 continuous background — no black bands framing the app.
                 Pre-mount this is the dark abyss (colors.page, dark);
                 ThemedStatusBar re-paints it at runtime to match the active
                 theme (light users get the paper field). */
              html, body { background-color: #061410; }

              /* iOS WebKit "text autosizing" inflates font sizes ~10-15% in
                 installed standalone PWAs (not in Safari tabs), which made
                 every label render bigger than the native app inside the same
                 px-sized cards — THE "PWA looks zoomed-in/bulky" culprit.
                 Confirmed by side-by-side shots: identical card widths, text
                 ~10% larger, earlier line wraps. Opting out pins CSS px font
                 sizes 1:1 with native pt sizes. */
              html {
                -webkit-text-size-adjust: 100%;
                text-size-adjust: 100%;
              }

              /* Kill the BROWSER's pull-down-to-reload on every page — it
                 reloaded the whole app from any screen. In-app refresh is
                 the usePullToRefresh hook, wired only on screens with live
                 data (RN's RefreshControl is a no-op in react-native-web). */
              html, body {
                overscroll-behavior-y: none;
                overscroll-behavior-x: none;
              }

              /* Brand body font on web.
                 applyGlobalFont.ts injects Inter as the base of every native
                 <Text>, but it deliberately no-ops on web (an array style
                 crashes react-native-web). react-native-web sets NO default
                 font-family on Text, so generic body text was inheriting the
                 system font (SF Pro on iOS) — visibly wider and heavier than
                 Inter, which is why the PWA read as a bulkier / zoomed-in
                 version of the native app (fewer filter chips fit per row, etc).
                 Setting the document default here makes generic text inherit
                 Inter to match native. Text with its own fontFamily
                 (Inter-Bold, SpaceGrotesk headings, Ionicons glyphs) sets it
                 inline via rnweb and still wins, so headings, the big numbers,
                 and icons are untouched. Form controls don't inherit fonts, so
                 they're named explicitly (native patches TextInput too). */
              html, body, input, textarea, select, button {
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
              }
              body > div:first-child { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; }

              /* The scaffold used to force "overflow: visible" on everything
                 inside a [role=tablist] [role=tab]. It dated from the
                 navigator's own web tab bar, which is long gone (the Tabs
                 navigator renders no bar at all now, and CustomTabBar's
                 buttons are role=button). The only tablist left is
                 SlidingSegments, where the rule DEFEATED numberOfLines:
                 react-native-web clamps lines with -webkit-line-clamp plus
                 overflow:hidden, so forcing overflow visible let a long
                 segment label wrap out of its 44px tile (Schedule's
                 "WEEKLY PLAN" in every web screenshot, while native clamped
                 it). Removed so the segments behave the same on the PWA as on
                 the device.

                 [role=heading] keeps its exemption - a heading's own box may
                 overflow so Unbounded / Space Grotesk descenders are never
                 shaved - but NOT its descendants: GradientText.web clamps a
                 single-line title with overflow:hidden plus text-overflow,
                 and a star selector here would defeat that too (the Masthead
                 title). */
              [role="heading"] { overflow: visible !important; }
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </body>
    </html>
  );
}
