/**
 * Vertex brand tokens — the single source of truth for Vertex Hub's identity.
 *
 * Palette from Vertex Organisation's own hub: deep forest surfaces with a lime
 * accent (the lime "vertex" wordmark with its X mesh) and a warm amber as the
 * secondary accent. Mirrors backend/core/brand.py (emails, /launch).
 *
 * Contrast rules the whole app follows:
 *   • lime is an ACCENT — anything written ON lime is dark (ink/forest);
 *   • lime TEXT only ever sits on forest/ink; on light surfaces text uses
 *     forest/mid (lime and lime-dark both fail 4.5:1 on paper);
 *   • every brand GRADIENT below is dark enough to carry white text.
 *
 * Both light/dark palettes in ThemeContext derive their values from here so
 * there is exactly one place to tune the brand. Theme-neutral things that
 * don't change between light/dark (fonts, the brand gradient, glows) live
 * directly on this module.
 */

// ── Names ────────────────────────────────────────────────────────────────────
// Every user-visible product/organisation name reads from here. Mirrors the
// backend's APP_NAME / ORG_NAME defaults (backend/core/brand.py).
export const APP_NAME = 'Vertex Hub';
export const APP_SHORT_NAME = 'Vertex';
export const ORG_NAME = 'Vertex Organisation';

// ── Raw brand palette ────────────────────────────────────────────────────────
export const brand = {
  // Vertex core palette
  forest: '#102d25',   // primary dark surface (ink blocks, dark cards)
  deep: '#0b211c',     // deepest brand green
  mid: '#244c3b',      // brand green that carries white text / reads on paper
  lime: '#b7df58',     // the accent — dark text on it, lime text only on forest
  limeDark: '#8caf38', // lime for graphics on light surfaces (not for text)
  paper: '#f0f4e9',    // light page
  card: '#f9faf4',     // light card face
  ink: '#17362b',      // body text on light surfaces
  muted: '#50675a',    // secondary text on light surfaces
  rule: '#cedbc7',     // hairlines on light surfaces
  amber: '#e7b65c',    // warm secondary accent

  // Derived
  sage: '#b5c8b2',     // muted text on forest/ink (8.3:1)
  leaf: '#3a7a56',     // lightest brand green that still carries white text (5.1:1)

  // Status (shared across the app — deliberately not brand greens)
  green: '#10B981',
  yellow: '#F59E0B',
  red: '#EF4444',
  grey: '#6B7280',
  cyan: '#22d3ee',
  rose: '#e0607e',

  // Accent washes
  accentDim: 'rgba(183,223,88,0.14)',
  accentGlow: 'rgba(140,175,56,0.30)',
  amberGlow: 'rgba(231,182,92,0.22)',
};

// ── Brand gradient (leaf → mid → forest) ─────────────────────────────────────
// Use with expo-linear-gradient: <LinearGradient colors={GRADIENT} .../>
// White text/icons sit on it everywhere (≥5.1:1 on the lightest stop).
export const GRADIENT = ['#3a7a56', '#27553f', '#173d30'] as const;
// Full-spectrum poster gradient (lime → leaf → forest) — cube faces, orbit rings
export const GRADIENT_FULL = ['#d7ef8f', '#b7df58', '#8caf38', '#3a7a56', '#244c3b'] as const;
// Soft translucent gradient for backdrops / glass cards
export const GRADIENT_SOFT = ['rgba(183,223,88,0.16)', 'rgba(36,76,59,0.16)'] as const;
// Deep panel gradient — hero cards / headers on dark surfaces
export const GRADIENT_PANEL = ['#1c4436', '#12342a', '#0b211c'] as const;

// ── Visual system v2 ("Ink & Cube") ─────────────────────────────────────────
// Title text on INK blocks, in both themes: solid lime (9.6:1 on forest).
// Three identical stops keep every GradientText call site unchanged.
export const GRADIENT_TEXT = ['#b7df58', '#b7df58', '#b7df58'] as const;
// Pop heroes — white text ≥4.5:1 on the lightest stop
export const GRADIENT_HERO = ['#3a7a56', '#244c3b', '#102d25'] as const;
// Ink block base — light theme / dark theme (dark ink must stay below the card)
export const GRADIENT_INK = ['#1f4a3a', '#143528', '#0b211c'] as const;
// Dark theme: the ink block runs BELOW the raised forest card (DepthCard adds
// a lime rim on dark ink faces so the pair still reads as two surfaces).
export const GRADIENT_INK_DARK = ['#0e271f', '#0a1f19', '#050f0c'] as const;
// XP bars, neon ring arcs, lit skill-tree rails
export const GRADIENT_XP = ['#3a7a56', '#8caf38', '#b7df58'] as const;
// Coin metals
export const GRADIENT_GOLD = ['#fff1a8', '#f0c53d', '#b8860b'] as const;
export const GRADIENT_STEEL = ['#e8e8f0', '#a9a9bd', '#6b6b80'] as const;
export const GRADIENT_BRONZE = ['#f1c9a3', '#cd7f32', '#8a4b1a'] as const;
// Holographic sheen that slides across depth cards on scroll (dark theme).
export const GRADIENT_HOLO = ['rgba(255,255,255,0)', 'rgba(183,223,88,0.07)', 'rgba(231,182,92,0.05)', 'rgba(255,255,255,0)'] as const;
// The same sheen for LIGHT cards — roughly a third of the alpha, so it reads
// as a highlight raking the face rather than a colour cast.
export const GRADIENT_HOLO_LIGHT = ['rgba(255,255,255,0)', 'rgba(183,223,88,0.06)', 'rgba(231,182,92,0.04)', 'rgba(255,255,255,0)'] as const;

// ── Fonts ────────────────────────────────────────────────────────────────────
// Family names here MUST match the keys registered in useFonts() in _layout.tsx.
// Space Grotesk = display/headings, Inter = body/UI, JetBrains Mono = data.
export const fonts = {
  display: 'SpaceGrotesk-Bold',
  displayMedium: 'SpaceGrotesk-Medium',
  displayRegular: 'SpaceGrotesk',
  body: 'Inter',
  bodyMedium: 'Inter-Medium',
  bodySemibold: 'Inter-SemiBold',
  bodyBold: 'Inter-Bold',
  mono: 'JetBrainsMono',
  monoSemibold: 'JetBrainsMono-SemiBold',
  // Unbounded — the editorial voice. NEVER stack fontWeight on these: expo-font's
  // web @font-face has no weight descriptor, so a fontWeight triggers faux-bold.
  displayWide: 'Unbounded-SemiBold',   // section heads, ribbons, segment labels, kickers ≥11px uppercase
  displayBlack: 'Unbounded-Black',     // mastheads, hero titles, stat numerals ≥20px
} as const;
