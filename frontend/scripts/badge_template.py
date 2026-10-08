"""Draw the neutral ID-badge template: frontend/assets/badges/badge-template.png.

The badge is a strip printed on A4, front on the left and back on the right,
folded down the middle. This template carries only generic artwork (frames,
labels, the signature box). Everything that identifies an organisation is
filled in by the app at print time from the server's settings:

    BADGE_ORG_NAME      who the holder is authorised by (default: ORG_NAME)
    BADGE_VERIFY_PHONE  the number a member of the public calls to check a badge
    BADGE_QR_URL_TEMPLATE  what the badge's QR code links to

It deliberately contains no charity, agency or regulator logos and no
signatures. If your organisation has its own approved badge artwork, replace
the PNG with it, keeping the same strip size (192.45 x 60.16 mm) and the field
positions in src/components/badges/BadgeStudio.tsx.

Run from the repo root (needs Pillow):
    python frontend/scripts/badge_template.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "badges" / "badge-template.png"
FONTS = ROOT / "assets" / "fonts"

STRIP_W_MM, STRIP_H_MM = 192.45, 60.16
PX_PER_MM = 600 / 25.4          # 600 dpi
W, H = round(STRIP_W_MM * PX_PER_MM), round(STRIP_H_MM * PX_PER_MM)

INK = "#1f2a2e"       # frames and headings
MUTED = "#5b6b70"     # labels
RULE = "#9aa7ab"      # underlines
FOLD_X = STRIP_W_MM / 2


def px(mm: float) -> int:
    return round(mm * PX_PER_MM)


def font(name: str, pt: float) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), round(pt / 72 * 600))


def main() -> None:
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    bold = lambda pt: font("Inter-Bold.ttf", pt)        # noqa: E731
    semi = lambda pt: font("Inter-SemiBold.ttf", pt)    # noqa: E731
    reg = lambda pt: font("Inter-Regular.ttf", pt)      # noqa: E731

    # Outer frames: front and back, with the fold line between them.
    lw = px(0.8)
    d.rectangle([0, 0, px(FOLD_X) - 1, H - 1], outline=INK, width=lw)
    d.rectangle([px(FOLD_X), 0, W - 1, H - 1], outline=INK, width=lw)

    # ── Front ────────────────────────────────────────────────────────────────
    # Photo frame (the app places the photo at x 5.11, y 3.48, 30.1 x 37.4 mm).
    d.rectangle([px(4.4), px(2.8), px(35.9), px(41.6)], outline=INK, width=px(0.5))
    # Divider bar between the photo column and the details.
    d.rectangle([px(40.0), px(3.5), px(40.9), px(57.0)], fill=INK)

    d.text((px(43.5), px(3.2)), "ID BADGE", font=bold(30), fill=INK)

    # Labels and underlines; the app writes the values just right of each label.
    for label, value_top in (("NAME:", 20.2), ("ID NUMBER:", 28.9), ("EXPIRY DATE:", 37.9)):
        d.text((px(43.5), px(value_top + 0.4)), label, font=semi(7.5), fill=MUTED)
        d.rectangle([px(43.5), px(value_top + 5.0), px(93.0), px(value_top + 5.5)], fill=RULE)

    # Authorised-by corner (org name + the badge's own QR are drawn by the app).
    d.text((px(3.0), px(43.4)), "AUTHORISED BY:", font=semi(5.5), fill=MUTED)
    d.text((px(43.5), px(47.4)), "ORGANISATION", font=semi(6.5), fill=MUTED)

    # ── Back ─────────────────────────────────────────────────────────────────
    bx, bw = px(FOLD_X + 3.0), px(FOLD_X - 6.0)
    lines = [
        "THE HOLDER OF THIS BADGE IS AUTHORISED BY",
        "THE ORGANISATION NAMED ON THE FRONT.",
        "TO CHECK THIS BADGE, PLEASE CALL:",
    ]
    f = semi(8.5)
    y = px(5.0)
    for line in lines:
        tw = d.textlength(line, font=f)
        d.text((bx + (bw - tw) / 2, y), line, font=f, fill=INK)
        y += px(5.0)
    # (the verification number is written by the app at y 21.5 mm)
    note = "IF IN ANY DOUBT, DO NOT GIVE ANY DETAILS."
    f2 = reg(7.5)
    tw = d.textlength(note, font=f2)
    d.text((bx + (bw - tw) / 2, px(32.5)), note, font=f2, fill=MUTED)

    d.text((bx, px(46.0)), "SIGNATURE", font=semi(8.5), fill=MUTED)
    d.rectangle([px(FOLD_X + 25.0), px(41.0), W - px(3.0), px(56.5)], outline=INK, width=px(0.5))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True, dpi=(600, 600))
    print(f"wrote {OUT.relative_to(ROOT.parent)} ({W}x{H})")


if __name__ == "__main__":
    main()
