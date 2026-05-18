#!/usr/bin/env python3
"""Render the iOS app icon (1024x1024) from assets/icon.svg.

Composition: sage-green wordmark on a white background, with the inner
`<` chevron rendered in black. Output is a 1024x1024 PNG written to
both `assets/icon-ios.png` and `mobile/ios/App/App/Assets.xcassets/
AppIcon.appiconset/AppIcon-512@2x.png` (Xcode auto-derives smaller
sizes from the 1024 master).

Re-run after editing `assets/icon.svg` or `assets/icon-chevron.svg`:

    python3 scripts/render-ios-icon.py

Requires `cairosvg` and `Pillow` (system pip works:
`python3 -m pip install --user --break-system-packages cairosvg Pillow`).
"""
from __future__ import annotations

import io
import shutil
import sys
from pathlib import Path

import cairosvg

# Sage primary green (matches --primary: hsl(108 18% 52%) in styles/app.css)
SAGE = "#779B6F"
BG = "#FFFFFF"
CHEVRON_FILL = "#000000"

# Match the previous dark-icon recipe: 1024x1024 canvas with a 112px inset
# so iOS' squircle rounding doesn't crop the outer sunburst rays.
SIZE = 1024
INSET = 112

REPO = Path(__file__).resolve().parent.parent
ICON_SVG = REPO / "assets" / "icon.svg"
CHEVRON_SVG = REPO / "assets" / "icon-chevron.svg"
OUT_ASSETS = REPO / "assets" / "icon-ios.png"
OUT_APPICON = (
    REPO / "mobile" / "ios" / "App" / "App" / "Assets.xcassets"
    / "AppIcon.appiconset" / "AppIcon-512@2x.png"
)


def _chevron_path_d() -> str:
    """Pull the chevron's `d` attribute from icon-chevron.svg so we can
    locate the matching path inside icon.svg and override its fill."""
    text = CHEVRON_SVG.read_text()
    # Crude but stable: icon-chevron.svg has exactly one <path d="...">
    start = text.index('d="') + 3
    end = text.index('"', start)
    return text[start:end]


def _recolor_icon_svg() -> str:
    """Return icon.svg with currentColor -> sage and the chevron -> black."""
    svg = ICON_SVG.read_text()

    # The wrapping <g> uses fill="currentColor". Pin it to sage so any
    # renderer (no CSS context) gets the right color.
    svg = svg.replace('fill="currentColor"', f'fill="{SAGE}"', 1)

    # Force the chevron path's fill via an explicit attribute. Match by
    # its `d` attribute (extracted from icon-chevron.svg) so this stays
    # robust if upstream path ordering changes.
    chevron_d = _chevron_path_d()
    needle = f'<path d="{chevron_d}"/>'
    replacement = f'<path fill="{CHEVRON_FILL}" d="{chevron_d}"/>'
    if needle not in svg:
        sys.exit(
            "ERROR: chevron path from icon-chevron.svg not found verbatim "
            "in icon.svg. Re-sync the two files or update this script."
        )
    svg = svg.replace(needle, replacement, 1)
    return svg


def _wrap_with_canvas(inner_svg: str) -> str:
    """Wrap the recolored icon SVG in a SIZE x SIZE white canvas with INSET."""
    inner_size = SIZE - 2 * INSET
    # Strip the outer <?xml ...?> declaration to embed cleanly.
    if inner_svg.startswith("<?xml"):
        inner_svg = inner_svg.split("?>", 1)[1].lstrip()
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">
  <rect width="{SIZE}" height="{SIZE}" fill="{BG}"/>
  <svg x="{INSET}" y="{INSET}" width="{inner_size}" height="{inner_size}" preserveAspectRatio="xMidYMid meet">
    {inner_svg}
  </svg>
</svg>
"""


def main() -> None:
    composed = _wrap_with_canvas(_recolor_icon_svg())
    png_bytes = cairosvg.svg2png(
        bytestring=composed.encode("utf-8"),
        output_width=SIZE,
        output_height=SIZE,
    )
    OUT_ASSETS.write_bytes(png_bytes)
    # Xcode auto-derives smaller sizes from the 1024 master, so the
    # appiconset only needs the single AppIcon-512@2x.png.
    shutil.copyfile(OUT_ASSETS, OUT_APPICON)
    print(f"wrote {OUT_ASSETS.relative_to(REPO)} ({len(png_bytes)} bytes)")
    print(f"wrote {OUT_APPICON.relative_to(REPO)} ({len(png_bytes)} bytes)")


if __name__ == "__main__":
    main()
