#!/usr/bin/env bash
# Regenerates every raster icon in public/ (and src/app/favicon.ico) from assets-src/logo.svg.
# Requires Inkscape (preferred, best SVG fidelity) or ImageMagick 7. Bump ASSET_VERSION in
# src/lib/asset-version.ts afterwards so browsers drop their cached copies.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

SRC=assets-src/logo.svg
OUT=public
# Absolute, inside the repo and not a dot-dir: the snap-packaged Inkscape can't see the host
# /tmp nor hidden folders, and resolves relative paths against $HOME instead of the cwd.
TMP=$(mktemp -d "$ROOT/icons-tmp.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

render() { # render <svg> <size> <out.png>
  if command -v inkscape >/dev/null 2>&1; then
    inkscape "$(realpath "$1")" --export-type=png --export-filename="$(realpath -m "$3")" -w "$2" -h "$2" >/dev/null 2>&1
  else
    magick -background none -density 384 "$1" -resize "$2x$2" "$3"
  fi
}

# Maskable variant: full-bleed square background, artwork shrunk into the 80% safe zone.
sed -e 's|<rect width="512" height="512" rx="116" fill="url(#bg)"/>|<rect width="512" height="512" fill="url(#bg)"/>|' \
    -e 's|<rect width="512" height="512" rx="116" fill="url(#glow)"/>|<rect width="512" height="512" fill="url(#glow)"/>|' \
    -e 's|<g id="art">|<g id="art" transform="translate(51.2 51.2) scale(0.8)">|' \
    "$SRC" > "$TMP/maskable.svg"

cp "$SRC" "$OUT/logo.svg"
render "$SRC" 512 "$OUT/icon-512.png"
render "$SRC" 192 "$OUT/icon-192.png"
render "$SRC" 256 "$OUT/logo.png"
render "$TMP/maskable.svg" 512 "$OUT/icon-maskable-512.png"
# iOS applies its own rounded mask and shows transparency as black: use the full-bleed tile.
render "$TMP/maskable.svg" 180 "$OUT/apple-touch-icon.png"

render "$SRC" 16 "$TMP/16.png"
render "$SRC" 32 "$TMP/32.png"
render "$SRC" 48 "$TMP/48.png"
magick "$TMP/16.png" "$TMP/32.png" "$TMP/48.png" src/app/favicon.ico

echo "Icônes générées dans $OUT/ et src/app/favicon.ico"
