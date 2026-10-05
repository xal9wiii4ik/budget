#!/usr/bin/env python3
"""Render the app icons. Run from anywhere: `python3 apps/web/scripts/make-icons.py`.

Pure standard library on purpose — no Pillow, no ImageMagick, nothing to install —
so the icons can be regenerated on any machine that has Python. The output IS
committed (public/icon.svg, public/icons/*.png): icons are art, not a build step.

The mark is three ascending bars on the accent colour. The accent is READ from
packages/shared/src/palette.ts, the one place the palette is written, so a
rebrand is "change the palette, rerun this".

Three shapes of the same drawing, because three consumers crop differently:
  * icon-192 / icon-512  — rounded square, transparent corners (purpose "any");
  * icon-maskable-512    — full bleed, mark inside the central 80% safe zone,
                           because Android cuts its own mask out of it;
  * apple-touch-icon     — full bleed and OPAQUE: iOS rounds the corners itself
                           and paints transparency black.
"""

from __future__ import annotations

import math
import re
import struct
import zlib
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
PALETTE = WEB.parent.parent / "packages" / "shared" / "src" / "palette.ts"
OUT = WEB / "public"

SUBROWS = 4  # vertical supersampling; horizontal coverage is exact
WHITE = (255, 255, 255)

# The mark, in a 0..1 box: (x0, y0, x1, y1) per bar, bottoms aligned.
BARS = ((0.00, 0.58, 0.24, 1.00), (0.38, 0.30, 0.62, 1.00), (0.76, 0.00, 1.00, 1.00))
BAR_RADIUS = 0.07  # of the mark box


def accent() -> tuple[int, int, int]:
    """LIGHT_PALETTE.accent — the first `accent:` in the file is the light one."""
    match = re.search(r"accent:\s*'#([0-9a-fA-F]{6})'", PALETTE.read_text())
    if match is None:
        raise SystemExit(f"no accent colour found in {PALETTE}")
    value = match.group(1)
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def span(y: float, x0: float, y0: float, x1: float, y1: float, r: float):
    """The x-extent of a rounded rectangle at height y, or None outside it."""
    if not y0 <= y <= y1:
        return None
    inset = 0.0
    if y < y0 + r:
        dy = y0 + r - y
        inset = r - math.sqrt(max(r * r - dy * dy, 0.0))
    elif y > y1 - r:
        dy = y - (y1 - r)
        inset = r - math.sqrt(max(r * r - dy * dy, 0.0))
    return x0 + inset, x1 - inset


def add(row: list[float], lo: float, hi: float, weight: float) -> None:
    """Add exact horizontal coverage of [lo, hi) to the pixel row."""
    lo, hi = max(lo, 0.0), min(hi, float(len(row)))
    if hi <= lo:
        return
    first, last = int(lo), min(int(hi), len(row) - 1)
    if first == last:
        row[first] += (hi - lo) * weight
        return
    row[first] += (first + 1 - lo) * weight
    for x in range(first + 1, last):
        row[x] += weight
    row[last] += (hi - last) * weight


def render(size: int, *, corner: float, mark: float, opaque: bool) -> bytes:
    """RGBA rows for one icon. `corner` and `mark` are fractions of the side."""
    bg = accent()
    radius = corner * size
    box = mark * size
    left = (size - box) / 2
    # Optical centring: the tallest bar is on the right, so the mass sits right
    # of centre; the box itself stays geometrically centred, which reads fine.
    top = (size - box) / 2
    bars = [
        (left + a * box, top + b * box, left + c * box, top + d * box) for a, b, c, d in BARS
    ]
    bar_r = BAR_RADIUS * box
    rows = bytearray()
    for py in range(size):
        cover_bg = [0.0] * size
        cover_mark = [0.0] * size
        for sub in range(SUBROWS):
            y = py + (sub + 0.5) / SUBROWS
            weight = 1.0 / SUBROWS
            base = span(y, 0.0, 0.0, float(size), float(size), radius)
            if base is not None:
                add(cover_bg, base[0], base[1], weight)
            for x0, y0, x1, y1 in bars:
                # Only the TOP corners are round: the bars stand on a baseline.
                bar = span(y, x0, y0, x1, y1 + bar_r, bar_r)
                if bar is not None and y <= y1:
                    add(cover_mark, bar[0], bar[1], weight)
        rows.append(0)  # PNG filter type: none
        for x in range(size):
            a = min(cover_bg[x], 1.0)
            m = min(cover_mark[x], a) / a if a > 0 else 0.0
            r, g, b = (round(bg[i] * (1 - m) + WHITE[i] * m) for i in range(3))
            if opaque:
                rows += bytes((r, g, b, 255))
            else:
                rows += bytes((r, g, b, round(a * 255)))
    return bytes(rows)


def png(size: int, rows: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )


def svg() -> str:
    """The same drawing as a vector favicon (64-unit box, 22% corner, 50% mark)."""
    r, g, b = accent()
    side, box = 64.0, 32.0
    left = top = (side - box) / 2
    rr = BAR_RADIUS * box

    def bar(a: float, t: float, c: float, d: float) -> str:
        # Top corners only, like the raster: the bars stand on a baseline.
        x0, y0, x1, y1 = left + a * box, top + t * box, left + c * box, top + d * box
        return (
            f"M{x0:.2f},{y1:.2f}V{y0 + rr:.2f}A{rr:.2f},{rr:.2f} 0 0 1 {x0 + rr:.2f},{y0:.2f}"
            f"H{x1 - rr:.2f}A{rr:.2f},{rr:.2f} 0 0 1 {x1:.2f},{y0 + rr:.2f}V{y1:.2f}Z"
        )

    rects = f'<path d="{"".join(bar(*b) for b in BARS)}"/>'
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" rx="{0.22 * side:.2f}" fill="#{r:02x}{g:02x}{b:02x}"/>'
        f'<g fill="#fff">{rects}</g></svg>\n'
    )


def main() -> None:
    icons = OUT / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    targets = (
        ("icon-192.png", 192, dict(corner=0.22, mark=0.50, opaque=False)),
        ("icon-512.png", 512, dict(corner=0.22, mark=0.50, opaque=False)),
        ("icon-maskable-512.png", 512, dict(corner=0.0, mark=0.40, opaque=True)),
        ("apple-touch-icon.png", 180, dict(corner=0.0, mark=0.46, opaque=True)),
    )
    for name, size, shape in targets:
        (icons / name).write_bytes(png(size, render(size, **shape)))
        print(f"wrote public/icons/{name} ({size}x{size})")
    (OUT / "icon.svg").write_text(svg())
    print("wrote public/icon.svg")


if __name__ == "__main__":
    main()
