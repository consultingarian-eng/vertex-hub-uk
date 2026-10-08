"""Vertex brand graphics, drawn from the Vertex Organisation logo.

The logo: a thin rounded "verte" wordmark, then an X whose left half is two
solid lime blades and whose right half breaks into a halftone dot field that
fades (smaller dots) towards the arm tips. Everything here is built from that
one geometry so the mark, the icons and the decorative pieces always match.

Run from the repo root:
    backendenv\Scripts\python.exe frontend\scriptsrand_assets.py        # SVGs
    backendenv\Scripts\python.exe frontend\scriptsrand_assets.py --png  # + every PNG icon/logo
SVGs go to frontend/assets/brand/ (plus backend/assets/icon.svg, the /launch
favicon); --png also rewrites the app icons, splash images, PWA icons, the
and the backend email/badge logo.
"""
from __future__ import annotations

import math
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "assets" / "brand"

# Brand palette (mirrors src/theme/brand.ts)
LIME = "#b7df58"
FOREST = "#102d25"
DEEP = "#0b211c"
PAPER = "#f0f4e9"

# ── The X, in its own 490 × 360 box ──────────────────────────────────────────
# Two 45° strokes, 130 wide (measured horizontally), crossing at (245, 180).
XW, XH = 490.0, 360.0
STROKE = 130.0
CX, CY = 245.0, 180.0
# The solid blades stop at a ">"-shaped 45° cut whose apex is at (CUT_APEX, CY).
CUT_APEX = 139.0
PITCH = 16.0          # halftone lattice: points (16i, 16j) with i + j even
R_MAX, R_MIN = 9.5, 1.6
FOCUS = (215.0, 180.0)  # dots are largest here and shrink with distance
FALLOFF = 380.0


def _in_stroke1(x, y, m=0.0):
    return y + m <= x <= y + STROKE - m


def _in_stroke2(x, y, m=0.0):
    return (XW - STROKE) - y + m <= x <= XW - y - m


def _cut(y):
    return CUT_APEX + abs(y - CY)


def blades_points():
    """The two solid blades (upper and lower), as polygon point lists."""
    # Upper blade: stroke 1 from the top edge down to the cut.
    y_left = (CUT_APEX + CY) / 2          # left edge x=y meets the cut
    y_right = (CUT_APEX + CY - STROKE) / 2  # right edge x=y+STROKE meets the cut
    upper = [(0, 0), (STROKE, 0), (y_right + STROKE, y_right), (y_left, y_left)]
    lower = [(x, XH - y) for x, y in upper]
    return upper, lower


def dot_radius(x, y, focus=FOCUS, falloff=FALLOFF, r_max=R_MAX, r_min=R_MIN):
    d = math.hypot(x - focus[0], y - focus[1])
    t = max(0.0, 1.0 - d / falloff)
    return r_min + (r_max - r_min) * t


def x_dots():
    """Halftone dots filling the right half of the X."""
    dots = []
    n = int(XW / PITCH) + 2
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            if (i + j) % 2:
                continue
            x, y = CX + i * PITCH, CY + j * PITCH
            r = dot_radius(x, y)
            if not (r <= y <= XH - r):
                continue
            if not (_in_stroke1(x, y, -r * 0.4) or _in_stroke2(x, y, -r * 0.4)):
                continue
            if x - r < _cut(y) + 3:
                continue
            dots.append((x, y, r))
    return dots


def _pts(points, dx=0.0, dy=0.0, sx=1.0, sy=1.0):
    return " ".join(f"{dx + px * sx:.1f},{dy + py * sy:.1f}" for px, py in points)


def x_mark_body(fill, dx=0.0, dy=0.0, s=1.0):
    upper, lower = blades_points()
    parts = [
        f'<polygon points="{_pts(upper, dx, dy, s, s)}"/>',
        f'<polygon points="{_pts(lower, dx, dy, s, s)}"/>',
    ]
    parts += [
        f'<circle cx="{dx + x * s:.1f}" cy="{dy + y * s:.1f}" r="{r * s:.2f}"/>'
        for x, y, r in x_dots()
    ]
    return f'<g fill="{fill}">' + "".join(parts) + "</g>"


# ── The "verte" wordmark, as stroked centre-lines ────────────────────────────
# Coordinates are in the logo's own space (x-height 395 → 492, stroke 11).
def _e(dx):
    return (
        f"M{530+dx} 443 H{655+dx} C{655+dx} 413 {635+dx} 395 {604+dx} 395 H{582+dx} "
        f"C{551+dx} 395 {530+dx} 414 {530+dx} 443 C{530+dx} 473 {551+dx} 492 {582+dx} 492 "
        f"H{618+dx} C{637+dx} 492 {649+dx} 486 {655+dx} 476"
    )


WORDMARK_PATHS = [
    "M377 395 L436 490 L495 395",                      # v
    _e(0),                                             # e
    "M695 492 V395 M695 438 C695 411 717 395 757 395",  # r
    "M812 350 V458 C812 480 824 492 846 492 M789 395 H845",  # t
    _e(348),                                           # e
]
X_ORIGIN = (928.0, 265.0)   # where the X box sits beside the wordmark


def wordmark_body(color):
    d = " ".join(WORDMARK_PATHS)
    return (
        f'<path d="{d}" fill="none" stroke="{color}" stroke-width="11" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
    )


def svg(w, h, body, view=None, title=None):
    vb = view or f"0 0 {w:g} {h:g}"
    t = f"<title>{title}</title>" if title else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:g}" height="{h:g}" '
        f'viewBox="{vb}">{t}{body}</svg>\n'
    )


# ── Assets ───────────────────────────────────────────────────────────────────
def logo(color):
    """Full lockup: verte + X."""
    x0, y0 = 360, 250
    w, h = 1060, 390
    body = wordmark_body(color) + x_mark_body(color, *X_ORIGIN)
    return svg(w, h, body, view=f"{x0} {y0} {w} {h}", title="Vertex")


def x_mark(color):
    pad = 10
    return svg(XW + 2 * pad, XH + 2 * pad, x_mark_body(color, pad, pad),
               title="Vertex X")


def app_tile(bg=FOREST, fg=LIME, size=1024, radius=0.0, scale=0.70):
    """Square icon: the X centred on a forest square (radius 0 = let the OS round it)."""
    s = size * scale / XW
    dx = (size - XW * s) / 2
    dy = (size - XH * s) / 2
    rect = f'<rect width="{size}" height="{size}" rx="{size * radius:g}" fill="{bg}"/>'
    return svg(size, size, rect + x_mark_body(fg, dx, dy, s), title="Vertex Hub")


def dot_field(w=360, h=360, color=LIME, corner="bottom-left", r_max=7.5, pitch=18.0):
    """A standalone halftone field that fades away from one corner —
    the logo's dots as a background texture (replaces the wireframe cubes)."""
    fx = 0.0 if "left" in corner else w
    fy = h if "bottom" in corner else 0.0
    reach = math.hypot(w, h) * 0.95
    dots = []
    n_i, n_j = int(w / pitch) + 1, int(h / pitch) + 1
    for i in range(n_i + 1):
        for j in range(n_j + 1):
            if (i + j) % 2:
                continue
            x, y = r_max + i * pitch, r_max + j * pitch
            r = dot_radius(x, y, (fx, fy), reach, r_max, 0.0)
            if r < 0.6:
                continue
            dots.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}"/>')
    return svg(w, h, f'<g fill="{color}">' + "".join(dots) + "</g>")


def dot_trail(w=240, h=24, color=LIME, pitch=14.0):
    """A row of dots shrinking to nothing — a divider / 'more this way' accent."""
    dots = []
    n = int(w / pitch)
    for k in range(n):
        t = 1 - k / n
        r = 0.6 + (min(h / 2 - 2, pitch * 0.4) - 0.6) * t ** 1.3
        dots.append(f'<circle cx="{h / 2 + k * pitch:.1f}" cy="{h / 2:.1f}" r="{r:.2f}"/>')
    return svg(w, h, f'<g fill="{color}">' + "".join(dots) + "</g>")


def blades(color=LIME):
    """The two solid blades on their own: a '>' chevron accent."""
    upper, lower = blades_points()
    maxx = max(p[0] for p in upper)
    body = (f'<g fill="{color}"><polygon points="{_pts(upper)}"/>'
            f'<polygon points="{_pts(lower)}"/></g>')
    return svg(maxx, XH, body, title="Vertex chevron")


ASSETS = {
    "vertex-logo-lime.svg": lambda: logo(LIME),        # on forest / dark
    "vertex-logo-forest.svg": lambda: logo(FOREST),    # on paper / light
    "vertex-x-lime.svg": lambda: x_mark(LIME),
    "vertex-x-forest.svg": lambda: x_mark(FOREST),
    "vertex-x-white.svg": lambda: x_mark("#ffffff"),   # monochrome (notification badge)
    "app-icon.svg": lambda: app_tile(),                # square; iOS/Android round it
    "app-icon-rounded.svg": lambda: app_tile(radius=0.22),
    "dot-field.svg": lambda: dot_field(),
    "dot-trail.svg": lambda: dot_trail(),
    "chevron-blades.svg": lambda: blades(),
}


# ── Raster icons and logos (PNG) ─────────────────────────────────────────────
REPO = Path(__file__).resolve().parents[2]


def x_canvas(size, fg, bg=None, width=0.70, radius=0.0):
    """The X centred on a size×size canvas, `width` of it wide; optional background."""
    s = size * width / XW
    dx, dy = (size - XW * s) / 2, (size - XH * s) / 2
    rect = f'<rect width="{size}" height="{size}" rx="{size * radius:g}" fill="{bg}"/>' if bg else ""
    return svg(size, size, rect + x_mark_body(fg, dx, dy, s))


def logo_canvas(w, h, color, width=0.8, bg=None, plate=None, plate_pad=0.0, radius=0.0):
    """The full lockup centred on a w×h canvas, `width` of it wide.
    `plate` draws a rounded colour plate behind the logo, `plate_pad` × w of margin."""
    lw = w * width
    s = lw / 1060
    lh = 390 * s
    x0, y0 = (w - lw) / 2, (h - lh) / 2
    parts = []
    if bg:
        parts.append(f'<rect width="{w}" height="{h}" fill="{bg}"/>')
    if plate:
        m = w * plate_pad
        parts.append(f'<rect x="{m:g}" y="{m:g}" width="{w - 2 * m:g}" height="{h - 2 * m:g}" '
                     f'rx="{w * radius:g}" fill="{plate}"/>')
    parts.append(f'<g transform="translate({x0 - 360 * s:.2f} {y0 - 250 * s:.2f}) scale({s:.5f})">'
                 + wordmark_body(color) + x_mark_body(color, *X_ORIGIN) + "</g>")
    return svg(w, h, "".join(parts))


# path (repo-relative) → (svg, width, height, keep_alpha)
def rasters():
    return {
        # App icon: full-bleed forest square (iOS/Android/PWA round the corners themselves)
        "frontend/assets/images/icon.png": (x_canvas(1024, LIME, FOREST), 1024, 1024, True),
        # Android adaptive foreground: X only, inside the 66 % safe zone
        "frontend/assets/images/adaptive-icon.png": (x_canvas(1024, LIME, width=0.52), 1024, 1024, True),
        "frontend/assets/images/favicon.png": (x_canvas(48, LIME, FOREST, width=0.78, radius=0.2), 48, 48, True),
        # Rounded tile (verify-email screen and anywhere a standalone mark is shown)
        "frontend/assets/logo.png": (x_canvas(1024, LIME, FOREST, radius=0.22), 1024, 1024, True),
        # Native splash (light: paper background from app.json; dark: #0b211c)
        "frontend/assets/images/splash-icon.png": (logo_canvas(1242, 1242, "#244c3b", width=0.86), 1242, 1242, True),
        "frontend/assets/images/splash-icon-dark.png": (logo_canvas(1242, 1242, LIME, width=0.86), 1242, 1242, True),
        # PWA / home-screen icons
        "frontend/public/icons/icon-192.png": (x_canvas(192, LIME, FOREST), 192, 192, True),
        "frontend/public/icons/icon-512.png": (x_canvas(512, LIME, FOREST), 512, 512, True),
        "frontend/public/icons/maskable-512.png": (x_canvas(512, LIME, FOREST, width=0.56), 512, 512, True),
        "frontend/public/icons/apple-touch-180.png": (x_canvas(180, LIME, FOREST), 180, 180, True),
        # Android notification badge: white silhouette on transparency
        "frontend/public/icons/badge-96.png": (x_canvas(96, "#ffffff", width=0.84), 96, 96, True),
        # Emails, /launch, public Bells pages, ID badges, bulletins (always on forest)
        "backend/assets/logo.png": (logo_canvas(1369, 454, LIME, width=0.97), 1369, 454, True),
    }


EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


def render_png(svg_text, out, w, h, keep_alpha, tmp):
    """Render an SVG with headless Edge at ≥1024 px, then downsample with Pillow."""
    import subprocess
    from PIL import Image

    scale = max(1, math.ceil(1024 / max(w, h)))
    W, H = w * scale, h * scale
    html = tmp / "render.html"
    html.write_text(
        '<!doctype html><html><body style="margin:0;background:transparent">'
        + svg_text.replace(f'width="{w:g}" height="{h:g}"', f'width="{W}" height="{H}"', 1)
        + "</body></html>", encoding="utf-8")
    shot = tmp / "shot.png"
    shot.unlink(missing_ok=True)
    subprocess.run([
        str(EDGE), "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--force-device-scale-factor=1", "--default-background-color=00000000",
        f"--user-data-dir={tmp / 'edge'}", f"--window-size={W},{H}",
        f"--screenshot={shot}", html.as_uri(),
    ], check=True, capture_output=True, timeout=60)
    # msedge.exe hands off to a child process and can return before the file lands.
    import time
    for _ in range(300):
        if shot.exists() and shot.stat().st_size > 0:
            time.sleep(0.3)
            break
        time.sleep(0.1)
    img = Image.open(shot).convert("RGBA").crop((0, 0, W, H))
    if scale > 1:
        img = img.resize((w, h), Image.LANCZOS)
    if not keep_alpha:
        img = img.convert("RGB")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)


def main():
    import sys
    import tempfile

    OUT.mkdir(parents=True, exist_ok=True)
    for name, make in ASSETS.items():
        (OUT / name).write_text(make(), encoding="utf-8")
        print("wrote", (OUT / name).relative_to(REPO))
    (REPO / "backend/assets/icon.svg").write_text(
        x_canvas(64, LIME, FOREST, width=0.78, radius=0.22), encoding="utf-8")
    print("wrote backend/assets/icon.svg")
    if "--png" not in sys.argv:
        return
    # PNGs need Pillow (the backend venv has it) and Microsoft Edge (Windows):
    #   backend\venv\Scripts\python.exe frontend\scripts\brand_assets.py --png
    with tempfile.TemporaryDirectory() as t:
        for rel, (svg_text, w, h, alpha) in rasters().items():
            render_png(svg_text, REPO / rel, w, h, alpha, Path(t))
            print("wrote", rel)


if __name__ == "__main__":
    main()
