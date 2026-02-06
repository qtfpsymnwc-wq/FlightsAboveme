#!/usr/bin/env node
/**
 * Copy airline logos from soaring-symbols into ui/assets/logos/<ICAO>.svg
 *
 * Usage: node scripts/vendor_logos.mjs <SRC_DIR> <DEST_DIR>
 */

import fs from "fs";
import path from "path";

const [,, srcDir, destDir] = process.argv;
if (!srcDir || !destDir) {
  console.error("Usage: node scripts/vendor_logos.mjs <SRC_DIR> <DEST_DIR>");
  process.exit(1);
}

const airlinesJsonPath = path.join(srcDir, "airlines.json");
if (!fs.existsSync(airlinesJsonPath)) {
  console.error(`ERROR: airlines.json not found at ${airlinesJsonPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(airlinesJsonPath, "utf8");
let airlines;
try {
  airlines = JSON.parse(raw);
} catch (e) {
  console.error("ERROR: Failed to parse airlines.json", e);
  process.exit(1);
}

// Expected schema: array of airline objects with at least { icao, iata, name, slug }
// We'll key off ICAO (3 letters). Some entries may omit ICAO.

function cleanIcao(v) {
  if (!v) return "";
  const s = String(v).trim().toUpperCase();
  // Most airline ICAO designators are 3 letters.
  if (!/^[A-Z0-9]{2,4}$/.test(s)) return "";
  return s;
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

let copied = 0;
let skipped = 0;
const manifest = {
  source: "https://github.com/anhthang/soaring-symbols",
  generatedAt: new Date().toISOString(),
  copied: {},
  skipped: [],
};

for (const a of airlines) {
  const icao = cleanIcao(a.icao);
  if (!icao) {
    skipped++;
    continue;
  }

  const slug = a.slug || a.id || a.code || "";
  if (!slug) {
    skipped++;
    continue;
  }

  // Try common locations. In soaring-symbols, assets are under /assets/<slug>/
  const base = path.join(srcDir, "assets", slug);
  const pick = firstExisting([
    path.join(base, "logo.svg"),
    path.join(base, "icon.svg"),
    path.join(base, "logo_color.svg"),
    path.join(base, "logo-colour.svg"),
    path.join(base, "logo-colored.svg"),
    path.join(base, "icon_color.svg"),
    path.join(base, "icon-colour.svg"),
  ]);

  if (!pick) {
    manifest.skipped.push({ icao, name: a.name || "", slug });
    skipped++;
    continue;
  }

  const out = path.join(destDir, `${icao}.svg`);
  fs.copyFileSync(pick, out);
  copied++;
  manifest.copied[icao] = {
    name: a.name || "",
    slug,
    from: path.relative(srcDir, pick).replaceAll("\\", "/"),
    to: path.relative(destDir, out).replaceAll("\\", "/"),
  };
}

// Write manifest alongside logos (handy for the logo test page)
try {
  fs.writeFileSync(path.join(destDir, "_manifest.json"), JSON.stringify(manifest, null, 2));
} catch (e) {
  // Non-fatal
}

console.log(`Copied ${copied} logos. Skipped ${skipped} (missing ICAO/slug/asset).`);
