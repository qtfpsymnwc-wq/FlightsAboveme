#!/usr/bin/env bash
set -euo pipefail

# Vendors airline logos (by ICAO) into ui/assets/logos/<ICAO>.svg during Cloudflare Pages builds.
#
# Source dataset (open-source): soaring-symbols, which provides airlines.json (includes ICAO)
# plus per-airline SVG assets.
# Repo: https://github.com/anhthang/soaring-symbols

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UI_LOGO_DIR="$ROOT_DIR/ui/assets/logos"
TMP_DIR="$ROOT_DIR/.tmp_vendor"

# Pin to a commit/branch for repeatable builds
SOARING_ZIP_URL="https://codeload.github.com/anhthang/soaring-symbols/zip/refs/heads/main"

mkdir -p "$UI_LOGO_DIR"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

echo "Downloading soaring-symbols..."
ZIP="$TMP_DIR/soaring-symbols.zip"
# curl is available in Cloudflare Pages build environments
curl -fsSL -L "$SOARING_ZIP_URL" -o "$ZIP"

echo "Extracting..."
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$ZIP" -d "$TMP_DIR"
else
  # Fallback if unzip isn't available
  python - <<'PY' "$ZIP" "$TMP_DIR"
import zipfile,sys
zip_path=sys.argv[1]
out_dir=sys.argv[2]
with zipfile.ZipFile(zip_path) as z:
    z.extractall(out_dir)
PY
fi

SRC_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name "soaring-symbols-*" | head -n 1)"
if [[ -z "${SRC_DIR}" ]]; then
  echo "ERROR: Could not locate extracted soaring-symbols folder" >&2
  exit 1
fi

echo "Copying logos into UI assets (by ICAO)..."
node "$ROOT_DIR/scripts/vendor_logos.mjs" "$SRC_DIR" "$UI_LOGO_DIR"

echo "Done. Logos available at /assets/logos/<ICAO>.svg (fallback _GENERIC.svg)."
