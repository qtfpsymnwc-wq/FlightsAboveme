/**
 * scripts/fetch_logos.mjs
 *
 * Downloads airline logo SVGs into ui/assets/logos/<ICAO>.svg
 *
 * Cloudflare Pages build command:
 *   node scripts/fetch_logos.mjs
 *
 * Why Special:FilePath?
 * - It stays stable even when Wikimedia upload URLs change.
 * - It reduces 404s caused by hardcoded /wikipedia/commons/<hash> paths.
 *
 * Notes:
 * - Airline logos are trademarks. Ensure you have rights to use them, especially commercially.
 * - On any failure, the existing placeholder SVG remains.
 */
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve("ui/assets/logos");

// ICAO -> Wikimedia Commons filename
// We fetch via: https://commons.wikimedia.org/wiki/Special:FilePath/<FILENAME>
const FILES = {
  // US majors / common carriers
  AAL: "American Airlines wordmark (2013).svg",
  DAL: "Delta logo.svg",
  UAL: "United_Airlines_logo_(1973_-_2010).svg",
  SWA: "Southwest Airlines logo 2014.svg",
  ASA: "Alaska Airlines Logo.svg",
  JBU: "JetBlue logo 2011.svg", // fallback if missing; will keep placeholder if 404
  FFT: "Frontier Airlines Logo.svg",
  NKS: "Spirit Airlines logo.svg",
  AAY: "Allegiant Air logo.svg",
  FDX: "FedEx Express.svg",

  // Regionals you commonly see in OpenSky / AeroDataBox (US)
  EDV: "Endeavor Air logo.svg",
  ENY: "Envoy air logo.svg",
  SKW: "SkyWest Airlines (United States) logo.svg",
  RPA: "Republic Airways 2019 Logo.svg",
  JIA: "PSA Airlines (OH) Logo.svg",
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function filePathUrl(filename) {
  // Special:FilePath accepts spaces, parens, etc; encodeURIComponent is safe.
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, tries = 4) {
  let lastStatus = 0;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "FlightWallLogoFetch/1.1 (+https://github.com/qtfpsymnwc-wq/FlightsAboveme)",
        "Accept": "image/svg+xml,image/*,*/*;q=0.8",
      },
    });

    lastStatus = res.status;

    if (res.status === 429 || res.status === 503) {
      // Rate limited / temporarily unavailable – backoff and retry
      const backoff = 1200 * (i + 1);
      await sleep(backoff);
      continue;
    }

    return res;
  }
  return { ok: false, status: lastStatus };
}

async function main() {
  ensureDir(OUT_DIR);

  const entries = Object.entries(FILES);

  for (let idx = 0; idx < entries.length; idx++) {
    const [icao, filename] = entries[idx];
    const dest = path.join(OUT_DIR, `${icao}.svg`);
    const url = filePathUrl(filename);

    try {
      // Skip download if file already exists and is non-empty.
      if (fs.existsSync(dest) && fs.statSync(dest).size > 20) {
        console.log(`↷ ${icao} already exists, skipping`);
        continue;
      }

      const res = await fetchWithRetry(url, 4);

      if (!res.ok) {
        console.log(`⚠ ${icao} failed (HTTP ${res.status} for ${url}). Keeping existing placeholder.`);
        await sleep(250);
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());

      // Basic sanity check (avoid writing HTML error pages)
      const head = buf.slice(0, 200).toString("utf8").toLowerCase();
      if (head.includes("<!doctype html") || head.includes("<html")) {
        console.log(`⚠ ${icao} got HTML instead of SVG. Keeping existing placeholder.`);
        await sleep(250);
        continue;
      }

      fs.writeFileSync(dest, buf);
      console.log(`✓ ${icao} -> ${dest}`);
    } catch (e) {
      console.log(`⚠ ${icao} error (${e?.message || "unknown"}). Keeping existing placeholder.`);
    }

    // Gentle throttle between requests to reduce 429s
    await sleep(300);
  }

  console.log("Finished");
}

await main();
