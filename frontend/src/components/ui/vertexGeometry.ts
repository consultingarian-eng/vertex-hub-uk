/**
 * Vertex X geometry — the logo's mark, as numbers.
 *
 * The Vertex Organisation logo's X: two solid lime blades on the left, and a
 * halftone dot field on the right whose dots shrink towards the arm tips.
 * This mirrors frontend/scripts/brand_assets.py (which writes the static
 * SVG/PNG assets), so the live mark and the icons are the same drawing.
 *
 * The X lives in a 490 × 360 box: two 45° strokes, 130 wide, crossing at
 * (245, 180). Everything is computed once at import.
 */

export const X_W = 490;
export const X_H = 360;
const STROKE = 130;
const CX = 245;
const CY = 180;
const CUT_APEX = 139;       // the blades stop at a ">" 45° cut with this apex
const PITCH = 16;           // lattice (16i, 16j) with i + j even
const R_MAX = 9.5;
const R_MIN = 1.6;
const FOCUS: [number, number] = [215, 180];
const FALLOFF = 380;

export interface Dot { x: number; y: number; r: number; /** 0 = centre … 1 = tips */ d: number }

const inStroke1 = (x: number, y: number, m: number) => y + m <= x && x <= y + STROKE - m;
const inStroke2 = (x: number, y: number, m: number) =>
  X_W - STROKE - y + m <= x && x <= X_W - y - m;
const cut = (y: number) => CUT_APEX + Math.abs(y - CY);

function radius(x: number, y: number) {
  const d = Math.hypot(x - FOCUS[0], y - FOCUS[1]);
  const t = Math.max(0, 1 - d / FALLOFF);
  return { r: R_MIN + (R_MAX - R_MIN) * t, d: Math.min(1, d / 320) };
}

function buildDots(): Dot[] {
  const dots: Dot[] = [];
  const n = Math.ceil(X_W / PITCH) + 2;
  for (let i = -n; i <= n; i += 1) {
    for (let j = -n; j <= n; j += 1) {
      if ((i + j) % 2 !== 0) continue;
      const x = CX + i * PITCH;
      const y = CY + j * PITCH;
      const { r, d } = radius(x, y);
      if (y < r || y > X_H - r) continue;
      if (!(inStroke1(x, y, -r * 0.4) || inStroke2(x, y, -r * 0.4))) continue;
      if (x - r < cut(y) + 3) continue;
      dots.push({ x, y, r, d });
    }
  }
  return dots;
}

export const X_DOTS: readonly Dot[] = buildDots();

// Upper blade: stroke 1 from the top edge down to the cut; lower mirrors it.
const yLeft = (CUT_APEX + CY) / 2;
const yRight = (CUT_APEX + CY - STROKE) / 2;
const UPPER: [number, number][] = [[0, 0], [STROKE, 0], [yRight + STROKE, yRight], [yLeft, yLeft]];
const LOWER: [number, number][] = UPPER.map(([x, y]) => [x, X_H - y]);
const pts = (p: [number, number][]) => p.map(([x, y]) => `${x},${y}`).join(' ');
export const X_BLADES: readonly string[] = [pts(UPPER), pts(LOWER)];

/** Dots grouped into `bands` rings by distance from the centre (for the ripple). */
export function dotBands(bands: number): Dot[][] {
  const out: Dot[][] = Array.from({ length: bands }, () => []);
  for (const dot of X_DOTS) out[Math.min(bands - 1, Math.floor(dot.d * bands))].push(dot);
  return out;
}

/**
 * A standalone halftone field (w × h) fading away from one corner — the
 * logo's dots as background texture.
 */
export function dotField(
  w: number,
  h: number,
  corner: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' = 'bottom-left',
  pitch = 18,
  rMax = 7.5,
): { x: number; y: number; r: number }[] {
  const fx = corner.endsWith('left') ? 0 : w;
  const fy = corner.startsWith('bottom') ? h : 0;
  const reach = Math.hypot(w, h) * 0.95;
  const out: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i * pitch <= w; i += 1) {
    for (let j = 0; j * pitch <= h; j += 1) {
      if ((i + j) % 2 !== 0) continue;
      const x = rMax + i * pitch;
      const y = rMax + j * pitch;
      const t = Math.max(0, 1 - Math.hypot(x - fx, y - fy) / reach);
      const r = rMax * t;
      if (r >= 0.6) out.push({ x, y, r });
    }
  }
  return out;
}
