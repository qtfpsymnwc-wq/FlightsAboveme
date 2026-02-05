#!/usr/bin/env bash
set -euo pipefail

# Downloads airline logo database (ICAO keyed) at build-time and overlays into UI assets.
# Source: https://github.com/sexym0nk3y/airline-logos
#
# This script is designed for Cloudflare Pages build environment.
#
# Behavior:
# - Downloads repo zip (main)
# - Copies ./logos/* into ui/assets/logos/
# - Does NOT delete existing files
# - Preserves ui/assets/logos/_GENERIC.svg (your fallback)

ROOT="$(pwd)"
UI_DIR="${ROOT}/ui"
TARGET="${UI_DIR}/assets/logos"
TMP="$(mktemp -d)"

echo "== FlightWall: vendor airline logos into ${TARGET} =="

mkdir -p "${TARGET}"

echo "Downloading logo database zip..."
curl -fsSL -o "${TMP}/airline-logos.zip" "https://codeload.github.com/sexym0nk3y/airline-logos/zip/refs/heads/main"

echo "Unzipping..."
unzip -q "${TMP}/airline-logos.zip" -d "${TMP}"

SRC_DIR="$(find "${TMP}" -maxdepth 2 -type d -name 'airline-logos-main' | head -n 1)/logos"
if [[ ! -d "${SRC_DIR}" ]]; then
  echo "ERROR: Could not find logos directory in zip." >&2
  exit 1
fi

# Preserve your generic fallback
if [[ -f "${TARGET}/_GENERIC.svg" ]]; then
  cp "${TARGET}/_GENERIC.svg" "${TMP}/_GENERIC.svg.bak"
fi

echo "Copying logos into UI assets (overlay)..."
# Copy without deleting existing files. We keep placeholders when upstream is missing.
# If you WANT to overwrite placeholders with upstream versions, change -n to -f.
cp -n "${SRC_DIR}/"* "${TARGET}/" 2>/dev/null || true

# Restore generic fallback (in case upstream had same name)
if [[ -f "${TMP}/_GENERIC.svg.bak" ]]; then
  cp -f "${TMP}/_GENERIC.svg.bak" "${TARGET}/_GENERIC.svg"
fi

echo "Done. Logos available at /assets/logos/<ICAO>.<ext> (fallback _GENERIC.svg)."
