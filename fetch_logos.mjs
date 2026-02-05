/**
 * fetch_logos.mjs
 *
 * Downloads airline logo SVGs into ui/assets/logos/<ICAO>.svg
 *
 * Why: I can't bundle trademarked airline logos in the repo by default.
 * This script pulls them from public sources during your build/deploy step.
 *
 * Usage (locally):
 *   node scripts/fetch_logos.mjs
 *
 * Usage (Cloudflare Pages Build command):
 *   node scripts/fetch_logos.mjs && npx wrangler deploy
 *
 * Notes:
 * - Logos are trademarks. Make sure you have rights to use them, especially for commercial use.
 * - If a download fails, the existing placeholder SVG remains.
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const OUT_DIR = path.resolve("ui/assets/logos");

const SOURCES = {
  // Majors
  AAL: "https://upload.wikimedia.org/wikipedia/commons/8/81/American_Airlines_wordmark_%282013%29.svg",
  DAL: "https://upload.wikimedia.org/wikipedia/commons/9/9d/Delta_logo.svg",
  UAL: "https://upload.wikimedia.org/wikipedia/commons/8/81/United_Airlines_logo_%281973_-_2010%29.svg",
  SWA: "https://upload.wikimedia.org/wikipedia/commons/6/6b/Southwest_Airlines_logo_2014.svg",
  ASA: "https://upload.wikimedia.org/wikipedia/commons/5/5d/Alaska_Airlines_logo.svg",
  JBU: "https://upload.wikimedia.org/wikipedia/commons/3/3c/JetBlue_Airways_Logo.svg",

  // ULCCs / leisure
  FFT: "https://upload.wikimedia.org/wikipedia/commons/6/61/Frontier_Airlines_Logo.svg",
  NKS: "https://upload.wikimedia.org/wikipedia/commons/7/7b/Spirit_Airlines_logo.svg",
  AAY: "https://upload.wikimedia.org/wikipedia/commons/8/8a/Allegiant_Air_logo.svg",

  // Cargo
  FDX: "https://upload.wikimedia.org/wikipedia/commons/9/9a/FedEx_Express.svg",

  // Regionals / commuters
  EDV: "https://upload.wikimedia.org/wikipedia/commons/2/29/Endeavor_Air_Logo.svg",
  ENY: "https://upload.wikimedia.org/wikipedia/commons/2/23/Envoy_air_logo.svg",
  SKW: "https://upload.wikimedia.org/wikipedia/commons/5/55/SkyWest_Airlines_%28United_States%29_logo.svg",
  RPA: "https://upload.wikimedia.org/wikipedia/commons/2/2d/Republic_Airways_2019_Logo.svg",
  JIA: "https://upload.wikimedia.org/wikipedia/commons/1/13/PSA_Airlines_%28OH%29_Logo.svg",
};

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "FlightWall/1.1.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location));
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  for (const [icao, url] of Object.entries(SOURCES)) {
    const outPath = path.join(OUT_DIR, `${icao}.svg`);
    try {
      const svg = await fetchText(url);

      // Basic sanity check
      if (!svg.trim().startsWith("<svg") && !svg.includes("<svg")) {
        throw new Error("Not an SVG response");
      }

      fs.writeFileSync(outPath, svg, "utf8");
      results.push({ icao, ok: true });
      console.log(`✓ ${icao} -> ${outPath}`);
    } catch (e) {
      results.push({ icao, ok: false, error: String(e?.message || e) });
      console.warn(`⚠ ${icao} failed (${e?.message || e}). Keeping existing placeholder.`);
    }
  }

  // Optional: write a small report file
  fs.writeFileSync(path.resolve("scripts/logo_fetch_report.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    results,
  }, null, 2));
})();
