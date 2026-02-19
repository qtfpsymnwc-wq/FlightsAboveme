// FlightsAboveMe UI
const API_BASE = window.location.origin;
// Cache-buster for static assets (CSS/JS/logos)
const UI_VERSION = "v234";

// Poll cadence
const POLL_MAIN_MS = 8000;
const POLL_KIOSK_MS = 12000;
const BACKOFF_429_MS = 60000;

// Enrichment timeouts (keep short so UI never “hangs” waiting on metadata)
const ENRICH_TIMEOUT_MS = 4500;
// Only enrich the closest flight if it's within this distance (miles)
const ENRICH_MAX_MI = 16;

// Closest-flight stability gating for AeroData enrichment (v1.4.1):
// Require the same primary callsign for 2 consecutive cycles before queuing /flight + /aircraft.
let primaryStableCs = null;
let primaryStableCount = 0;
let lastEnrichQueuedKey = null;
let lastEnrichQueuedAt = 0;
// Performance tuning (v1.3.1): allow slower cellular fetches for states
const STATES_TIMEOUT_MS = 16000;
const GEO_TIMEOUT_MS = 12000;
const LAST_LOC_KEY = "fam_last_loc_v1";

// Enrichment budgets (per “cycle”)
// v1.2.9+: only enrich the closest flight (within ENRICH_MAX_MI)
const LIST_AIRCRAFT_BUDGET = 0;
const LIST_ROUTE_BUDGET = 0;

const enrichCache = new Map();       // key: `${hex}|${callsign}` -> {routeText, modelText, airlineName}
const enrichInFlight = new Set();    // keys currently being enriched
const enrichQueue = [];              // queue of { type, flight, key }
let enrichPumpRunning = false;

const $ = (id) => document.getElementById(id);
const errBox = $("errBox");

// Keep error box plumbing (harmless even if element is missing).
function showErr(msg){
  const m = String(msg||"");
  if (/AbortError/i.test(m) || /fetch aborted/i.test(m) || /aborted/i.test(m)) return;
  try {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
  } catch {}
}

// Debug-only error toasts (avoid showing 3rd-party script noise to users)
const __DEBUG = new URLSearchParams(location.search).has("debug");
if (__DEBUG){
  window.addEventListener("error", (e)=>showErr("JS error: " + (e?.message || e)));
  window.addEventListener("unhandledrejection", (e)=>showErr("Promise rejection: " + (e?.reason?.message || e?.reason || e)));
}
const nm = (v) => (v ?? "").toString().trim();


// Best-effort aircraft type/model hint from live state payloads (OpenSky array + some ADS-B fallbacks).
// Returns "" when unavailable. Safe to call on every state row.
function liveModelHintFromState(s){
  try{
    // Most OpenSky "states" rows are arrays. Some providers may append extra fields.
    if (Array.isArray(s)){
      // Try a few likely indices (provider-dependent). Only accept short-ish strings.
      for (const idx of [16,17,18,19,20]) {
        const v = s[idx];
        if (typeof v === "string") {
          const t = nm(v).replace(/^"+|"+$/g,"");
          if (t && t.length <= 16) return t;
        }
      }
    } else if (s && typeof s === "object") {
      // If a provider ever returns objects, try common keys.
      const candidates = [s.type, s.aircraft_type, s.aircraftType, s.model, s.t];
      for (const v of candidates) {
        if (typeof v === "string") {
          const t = nm(v);
          if (t && t.length <= 32) return t;
        }
      }
    }
  } catch {}
  return "";
}

function normalizeCallsign(cs){
  return nm(cs).replace(/\s+/g,"").toUpperCase();
}

function haversineMi(lat1, lon1, lat2, lon2){
  const R = 3958.7613;
  const toRad = (d)=>d*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

/* Kiosk detection */
function isKiosk(){
  try {
    if (window.__KIOSK_MODE__ === true) return true;
    if (document.body.classList.contains("kiosk")) return true;
    const p = new URLSearchParams(location.search);
    if (p.get("kiosk") === "1" || p.get("kiosk") === "true") return true;
    if ((location.pathname || "").toLowerCase().endsWith("/kiosk.html")) return true;
    return false;
  } catch {
    return false;
  }
}

function enableKioskIfRequested(){
  if (!isKiosk()) return;
  try { document.body.classList.add("kiosk"); } catch {}
  try { window.__KIOSK_MODE__ = true; } catch {}
}

/* Portrait detection helper */
function isPortrait(){
  try {
    return window.matchMedia && window.matchMedia("(orientation: portrait)").matches;
  } catch {
    return false;
  }
}

/* TRK formatting: allow short (no degrees) for kiosk portrait */
function headingToText(deg, opts={}){
  if (!Number.isFinite(deg)) return "—";
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  const idx = Math.round((((deg%360)+360)%360) / 45) % 8;
  const card = dirs[idx];
  const d = Math.round(deg);

  if (opts && opts.short === true) return card;
  return card + ` (${d}°)`;
}

/* Normal (non-compact) formatters */
function fmtAlt(m) {
  if (!Number.isFinite(m)) return "—";
  const ft = m * 3.28084;
  return Math.round(ft).toLocaleString() + " ft";
}
function fmtSpd(ms) {
  if (!Number.isFinite(ms)) return "—";
  const mph = ms * 2.236936292;
  return Math.round(mph) + " mph";
}
function fmtMi(mi) {
  if (!Number.isFinite(mi)) return "—";
  return mi.toFixed(mi < 10 ? 1 : 0) + " mi";
}

/* Compact formatters for kiosk iPhone portrait (prevents clipping) */
function fmtAltCompact(m){
  if (!Number.isFinite(m)) return "—";
  const ft = m * 3.28084;
  const kft = ft / 1000;
  const decimals = (kft < 10) ? 2 : 1;
  return kft.toFixed(decimals) + "kft";
}
function fmtSpdCompact(ms){
  if (!Number.isFinite(ms)) return "—";
  const mph = ms * 2.236936292;
  return Math.round(mph) + "mph";
}
function fmtMiCompact(mi){
  if (!Number.isFinite(mi)) return "—";
  return mi.toFixed(mi < 10 ? 1 : 0) + "mi";
}

// Compact alt formatter for kiosk tablet / iPad (prevents stat overflow)
function fmtAltKft(m){
  if (!Number.isFinite(m)) return "—";
  const ft = m * 3.28084;
  return (ft/1000).toFixed(1) + "k ft";
}

// Vertical speed (m/s) → simple flight phase label
// OpenSky may return null; treat null/near-zero as cruising.
function fmtVS(vr){
  // vr is meters/second (state[11])
  if (!Number.isFinite(vr)) return "Cruising";

  // Thresholds (m/s). ~0.5 m/s ≈ 100 fpm.
  if (vr > 0.5) return "Climbing";
  if (vr < -0.5) return "Descending";
  return "Cruising";
}

// Squawk (transponder) definitions.
// OpenSky may return "" / null / "0000"; treat as not set.
// Replace code with a definition (no raw code shown).
function fmtSquawkMeaning(sq){
  const s = (sq ?? "").toString().trim();
  if (!s || s === "0000") return null;

  // Emergency squawks
  if (s === "7500") return "Hijacking";
  if (s === "7600") return "Radio Failure";
  if (s === "7700") return "Emergency";

  // Common VFR codes (region-dependent, but useful as a friendly label)
  if (s === "1200" || s === "7000") return "VFR";

  return "ATC Assigned";
}

function setSquawkUI(sq, squawkId, sepId){
  const squawkEl = $(squawkId);
  if (!squawkEl) return;
  const sepEl = sepId ? $(sepId) : null;

  const meaning = fmtSquawkMeaning(sq);
  if (!meaning) {
    squawkEl.textContent = "";
    squawkEl.style.display = "none";
    if (sepEl) sepEl.style.display = "none";
    return;
  }

  squawkEl.textContent = meaning;
  squawkEl.style.display = "";
  if (sepEl) sepEl.style.display = "";
}


function guessAirline(callsign){
  const c=(callsign||'').trim().toUpperCase();
  const p3=c.slice(0,3);
  const map={AAL:'American',ASA:'Alaska',DAL:'Delta',FFT:'Frontier',JBU:'JetBlue',NKS:'Spirit',SKW:'SkyWest',SWA:'Southwest',UAL:'United',AAY:'Allegiant',ENY:'Envoy',JIA:'PSA',RPA:'Republic',GJS:'GoJet',EDV:'Endeavor'};
  return map[p3]||null;
}

function airlineKeyFromCallsign(callsign){
  const cs=(callsign||'').trim().toUpperCase();
  const m = cs.match(/^([A-Z]{3})/);
  return m ? m[1] : null;
}

// PNG-first → SVG fallback → generic SVG
function logoUrlForKey(key, ext){
  const k = (key || "").toString().trim().toUpperCase();
  const file = k ? `${k}.${ext}` : `_GENERIC.${ext}`;
  return `/assets/logos/${file}?v=${encodeURIComponent(UI_VERSION)}`;
}
function logoCandidatesForKey(key){
  return [
    logoUrlForKey(key, "png"),
    logoUrlForKey(key, "svg"),
    logoUrlForKey("", "svg"),
  ];
}
function logoCandidatesForFlight(f){
  const key =
    (f?.airlineIcao || f?.operatorIcao || airlineKeyFromCallsign(f?.callsign || ""))?.toUpperCase?.() ||
    airlineKeyFromCallsign(f?.callsign || "");
  return logoCandidatesForKey(key);
}

function bboxAround(lat, lon){
  const dLat = 0.6;
  const dLon = 0.8;
  return {
    lamin: (lat - dLat).toFixed(4),
    lamax: (lat + dLat).toFixed(4),
    lomin: (lon - dLon).toFixed(4),
    lomax: (lon + dLon).toFixed(4),
  };
}

// Last-known location fallback (v1.3.1 performance patch)
function saveLastLocation(lat, lon, accuracy){
  try {
    const obj = { lat:Number(lat), lon:Number(lon), accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null, ts: Date.now() };
    localStorage.setItem(LAST_LOC_KEY, JSON.stringify(obj));
  } catch {}
}
function loadLastLocation(maxAgeMs = 1000 * 60 * 60 * 24 * 7){
  try {
    const raw = localStorage.getItem(LAST_LOC_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj) return null;
    if (!Number.isFinite(Number(obj.lat)) || !Number.isFinite(Number(obj.lon))) return null;
    const ts = Number(obj.ts || 0);
    if (ts && (Date.now() - ts) > maxAgeMs) return null;
    return { lat: Number(obj.lat), lon: Number(obj.lon), accuracy: obj.accuracy ?? null, ts };
  } catch {
    return null;
  }
}


async function fetchJSON(url, timeoutMs=9000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache:"no-store", credentials:"omit" });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,220)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

// Location-denied demo fallback.
// If the user declines location permission, we show a demo area around Fayetteville, Arkansas (ZIP 72704).
// Manual ZIP entry has been intentionally removed.
const DEMO_LOC = { lat: 36.0877, lon: -94.3093, label: "Fayetteville, Arkansas", zip: "72704" };

/* Portrait route formatting: show only airport codes in kiosk portrait
   IMPORTANT: Never drop destination. If we can't extract BOTH codes, return original.
*/
function extractCodesFromSide(sideText){
  const s = nm(sideText).toUpperCase();
  if (!s) return [];

  // Prefer codes in parentheses
  const paren = [...s.matchAll(/\(([A-Z0-9]{3,4})\)/g)].map(m => m[1]);
  if (paren.length) return paren;

  // Otherwise bare codes
  return [...s.matchAll(/\b[A-Z0-9]{3,4}\b/g)].map(m => m[0]);
}

function routeCodesOnly(text){
  const raw = nm(text);
  if (!raw || raw === "—") return raw || "—";

  const t = raw.replace(/\s+/g, " ").trim();
  const arrowMatch = t.split(/\s*(?:→|->|→)\s*/);

  if (arrowMatch.length >= 2) {
    const left = arrowMatch[0];
    const right = arrowMatch.slice(1).join(" ");

    const leftCodes = extractCodesFromSide(left);
    const rightCodes = extractCodesFromSide(right);

    const o = leftCodes.length ? leftCodes[leftCodes.length - 1] : null;
    const d = rightCodes.length ? rightCodes[rightCodes.length - 1] : null;

    if (o && d && o !== d) return `${o} → ${d}`;
    return raw;
  }

  const parenCodes = [...raw.toUpperCase().matchAll(/\(([A-Z0-9]{3,4})\)/g)].map(m => m[1]);
  if (parenCodes.length >= 2) return `${parenCodes[0]} → ${parenCodes[parenCodes.length - 1]}`;

  const bareCodes = [...raw.toUpperCase().matchAll(/\b[A-Z0-9]{3,4}\b/g)].map(m => m[0]);
  if (bareCodes.length >= 2) return `${bareCodes[0]} → ${bareCodes[bareCodes.length - 1]}`;

  return raw;
}

function formatRouteForDisplay(routeText){
  const t = nm(routeText);
  if (!t) return "";
  if (isKiosk() && isPortrait()) return routeCodesOnly(t);
  return t;
}

// -------------------- Rendering --------------------

/**
 * Airline display policy:
 * - Use enriched airlineName if present
 * - Else use guessed airline if present
 * - Else:
 *   - N-number callsigns -> "General Aviation"
 *   - Airline-pattern callsigns (AAA123) -> "Unknown Airline"
 *   - Else: non-US country if present
 *   - Else: blank (no "—")
 */
function airlineDisplayFromFlight(f){
  const cs = normalizeCallsign(f?.callsign || "");
  const inferred = nm(f?.airlineName) || nm(f?.airlineGuess) || nm(guessAirline(f?.callsign));

  if (inferred) return inferred;

  if (isNNumberCallsign(cs)) return "General Aviation";

  const airlinePattern = /^[A-Z]{3}\d/;
  if (airlinePattern.test(cs)) return "Unknown Airline";

  if (f?.country && f.country !== "United States") return f.country;

  return "";
}

function renderPrimary(f, radarMeta){
  if ($("callsign")) $("callsign").textContent = f.callsign || "—";
  if ($("icao24")) $("icao24").textContent = f.icao24 || "—";

  const a1 = airlineDisplayFromFlight(f);
  if ($("airline")) $("airline").textContent = a1 || " ";

  const img = $("airlineLogo");
  if (img) {
    const candidates = logoCandidatesForFlight(f);
    let i = 0;
    img.onerror = () => { i += 1; if (i < candidates.length) img.src = candidates[i]; };
    img.src = candidates[0];
    img.classList.remove("hidden");
  }

  const compactStats = (isKiosk() && isPortrait() && window.innerWidth <= 430);
  const kioskTabletAlt = (isKiosk() && window.innerWidth >= 700);

  if ($("alt")) $("alt").textContent = compactStats ? fmtAltCompact(f.baroAlt) : (kioskTabletAlt ? fmtAltKft(f.baroAlt) : fmtAlt(f.baroAlt));
  if ($("spd")) $("spd").textContent = compactStats ? fmtSpdCompact(f.velocity) : fmtSpd(f.velocity);
  if ($("dist")) $("dist").textContent = compactStats ? fmtMiCompact(f.distanceMi) : fmtMi(f.distanceMi);

  if ($("vs")) $("vs").textContent = fmtVS(f.verticalRate);
  setSquawkUI(f.squawk, "squawk", "sqSep");

  if ($("dir")) $("dir").textContent = headingToText(
    f.trueTrack,
    { short: (isKiosk() && isPortrait()) }
  );

  // Route: hide when not available (no placeholder dashes)
  const routeDisp = formatRouteForDisplay(f.routeText);
  const routeEl = $("route");
  if (routeEl) {
    routeEl.textContent = routeDisp;
    routeEl.style.display = routeDisp ? "" : "none";
  }

  // Aircraft type/model: show live hint until enriched; hide when unknown
  const modelDisp = f.modelText || f.modelHint || "";
  const modelEl = $("model");
  if (modelEl) {
    modelEl.textContent = modelDisp;
    modelEl.style.display = modelDisp ? "" : "none";
  }

  if ($("radarLine")) $("radarLine").textContent =
    `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;
}

function renderSecondary(f){
  if (!$("callsign2") && !$("airline2")) return;

  if (!f) {
    $("kioskSecondaryCard") && ($("kioskSecondaryCard").style.display = "none");
    return;
  }
  $("kioskSecondaryCard") && ($("kioskSecondaryCard").style.display = "");

  $("callsign2").textContent = f.callsign || "—";
  $("icao242").textContent = f.icao24 || "—";

  const a2 = airlineDisplayFromFlight(f);
  $("airline2").textContent = a2 || " ";

  const img2 = $("airlineLogo2");
  if (img2) {
    const candidates = logoCandidatesForFlight(f);
    let i = 0;
    img2.onerror = () => { i += 1; if (i < candidates.length) img2.src = candidates[i]; };
    img2.src = candidates[0];
    img2.classList.remove("hidden");
  }

  const routeDisp2 = formatRouteForDisplay(f.routeText);
  const r2 = $("route2");
  if (r2) {
    r2.textContent = routeDisp2;
    r2.style.display = routeDisp2 ? "" : "none";
  }

  const modelDisp2 = f.modelText || f.modelHint || "";
  const m2 = $("model2");
  if (m2) {
    m2.textContent = modelDisp2;
    m2.style.display = modelDisp2 ? "" : "none";
  }

  const compactStats = (isKiosk() && isPortrait() && window.innerWidth <= 430);

  $("dist2").textContent = compactStats ? fmtMiCompact(f.distanceMi) : fmtMi(f.distanceMi);
  $("alt2").textContent = compactStats ? fmtAltCompact(f.baroAlt) : fmtAlt(f.baroAlt);
  $("spd2").textContent = compactStats ? fmtSpdCompact(f.velocity) : fmtSpd(f.velocity);

  if ($("vs2")) $("vs2").textContent = fmtVS(f.verticalRate);
  setSquawkUI(f.squawk, "squawk2", "sqSep2");

  $("dir2").textContent = headingToText(
    f.trueTrack,
    { short: (isKiosk() && isPortrait()) }
  );
}

/* ✅ Nearby flights: ONLY callsign + altitude + distance (one clean line) */
function renderList(list){
  const el = $("list");
  if (!el) return;
  el.innerHTML = "";

  list.forEach((f)=>{
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="cs">${f.callsign || "—"}</div>
      <div class="a">${fmtAlt(f.baroAlt)}</div>
      <div class="d">${fmtMi(f.distanceMi)}</div>
    `;
    el.appendChild(row);
  });
}

// -------------------- Grouping (Airlines vs Other) --------------------

const TIER_A_PREFIXES = ["AAL","DAL","UAL","SWA","ASA","FFT","NKS","JBU","AAY"];
const TIER_B_EXTRA_PREFIXES = ["SKW","ENY","EDV","JIA","RPA","GJS","UPS","FDX"];
const TIER_ALL_PREFIXES = [...new Set([...TIER_A_PREFIXES, ...TIER_B_EXTRA_PREFIXES])];

const CARGO_PREFIXES = ["FDX","UPS","GTI","ABX","CKS","KAL","BOX","MXY","ATN"];
const MIL_GOV_PREFIXES = ["RCH","SAM","GAF","NOW","BAF","DAF","NAV","FNY","SPAR"];
const PRIVATE_PREFIXES = ["EJA","NJE","XOJ","LXJ","JTL","PJC","DCM","VJT"];

function callsignPrefix(cs){
  const s = normalizeCallsign(cs);
  const m = s.match(/^[A-Z]{3}/);
  if (m) return m[0];
  return s.slice(0,3);
}
function isNNumberCallsign(cs){
  const c = normalizeCallsign(cs);
  return /^N\d/.test(c);
}
function groupForFlight(cs){
  const p = callsignPrefix(cs);
  if (!p) return "B";
  if (isNNumberCallsign(cs)) return "B";
  if (CARGO_PREFIXES.includes(p) || MIL_GOV_PREFIXES.includes(p) || PRIVATE_PREFIXES.includes(p)) return "B";
  if (TIER_ALL_PREFIXES.includes(p)) return "A";
  return "B";
}

// -------------------- Enrichment (fast + safe) --------------------

function cacheKeyForFlight(f){
  const cs = normalizeCallsign(f.callsign);
  const hex = nm(f.icao24).toLowerCase();
  return `${hex}|${cs}`;
}

function applyCachedEnrichment(f){
  const k = cacheKeyForFlight(f);
  const cached = enrichCache.get(k);
  if (cached) Object.assign(f, cached);
}

async function enrichRoute(f){
  const cs = normalizeCallsign(f.callsign);
  if (!cs) return;

  const k = cacheKeyForFlight(f);
  try {
    const data = await fetchJSON(`${API_BASE}/api/flight/${encodeURIComponent(cs)}`, ENRICH_TIMEOUT_MS);
    if (data && data.ok) {
      const patch = {
        routeText: data.route || f.routeText,
        airlineName: data.airlineName || f.airlineName,
        airlineGuess: f.airlineGuess || guessAirline(f.callsign),
      };
      if (!f.modelText && data.aircraftModel) patch.modelText = data.aircraftModel;

      enrichCache.set(k, { ...(enrichCache.get(k) || {}), ...patch });
      Object.assign(f, patch);
    }
  } catch {}
}

async function enrichAircraft(f){
  const hex = nm(f.icao24).toLowerCase();
  if (!hex) return;

  const k = cacheKeyForFlight(f);
  try {
    const data = await fetchJSON(`${API_BASE}/api/aircraft/icao24/${encodeURIComponent(hex)}`, ENRICH_TIMEOUT_MS);
    if (!data) return;
    if (data.ok === false) return;
    if (data.found === false) return;

    const typeName = nm(data.typeName);
    const model = nm(data.model) || nm(data.modelName);
    const code = nm(data.modelCode) || nm(data.icaoCode) || nm(data.iataCodeShort);

    let out = typeName || model || "—";
    if (code && out !== "—" && !out.includes(code)) out += ` (${code})`;

    const patch = { modelText: out };
    enrichCache.set(k, { ...(enrichCache.get(k) || {}), ...patch });
    Object.assign(f, patch);
  } catch {}
}

// Queue helpers
function queueEnrich(type, f){
  const k = cacheKeyForFlight(f);
  const inflightKey = `${type}:${k}`;
  if (enrichInFlight.has(inflightKey)) return;

  for (let i = 0; i < enrichQueue.length; i++) {
    if (enrichQueue[i].type === type && enrichQueue[i].key === k) return;
  }

  enrichQueue.push({ type, flight: f, key: k });
}

function pumpEnrichment(renderFn){
  if (enrichPumpRunning) return;
  enrichPumpRunning = true;

  const run = async () => {
    try {
      let batch = 0;
      while (enrichQueue.length && batch < 3) {
        const job = enrichQueue.shift();
        if (!job) break;

        const inflightKey = `${job.type}:${job.key}`;
        if (enrichInFlight.has(inflightKey)) continue;

        enrichInFlight.add(inflightKey);
        try {
          if (job.type === "aircraft") await enrichAircraft(job.flight);
          else await enrichRoute(job.flight);
        } finally {
          enrichInFlight.delete(inflightKey);
        }

        batch += 1;
        renderFn();
      }
    } finally {
      enrichPumpRunning = false;
      if (enrichQueue.length) setTimeout(() => pumpEnrichment(renderFn), 250);
    }
  };

  run();
}

// -------------------- Main loop --------------------

async function main(){
  enableKioskIfRequested();

  // Optional publisher intro expander (only exists on the main homepage)
  const pubToggle = document.getElementById("pubToggle");
  const pubMore = document.getElementById("pubMore");


  // Publisher intro: collapse long text on mobile, expand on demand
  if (pubToggle && pubMore) {
    pubToggle.addEventListener("click", ()=>{
      const expanded = pubToggle.getAttribute("aria-expanded") === "true";
      pubToggle.setAttribute("aria-expanded", (!expanded).toString());
      pubMore.hidden = expanded;
      pubToggle.textContent = expanded ? "Read more" : "Read less";
    });
  }


  const statusEl = $("statusText");
  if (statusEl) statusEl.textContent = "Locating…";

  const tierSegment = document.getElementById("tierSegment");
  let tier = (localStorage.getItem("fw_tier") || "A").toUpperCase();
  if (tier !== "A" && tier !== "B") tier = "A";

  function syncTierButtons(){
    if (!tierSegment) return;
    [...tierSegment.querySelectorAll("button[data-tier]")].forEach((b)=>{
      const t = (b.getAttribute("data-tier") || "A").toUpperCase();
      b.classList.toggle("active", t === tier);
    });
  }
  if (tierSegment) {
    tierSegment.addEventListener("click", (e)=>{
      const btn = e.target && e.target.closest ? e.target.closest("button[data-tier]") : null;
      if (!btn) return;
      tier = (btn.getAttribute("data-tier") || "A").toUpperCase();
      if (tier !== "A" && tier !== "B") tier = "A";
      localStorage.setItem("fw_tier", tier);
      syncTierButtons();
    });
    syncTierButtons();
  }

  const pos = await new Promise((resolve, reject)=>{
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      (p)=>resolve(p),
      (e)=>reject(new Error(e.message || "Location denied")),
      { enableHighAccuracy:true, timeout:GEO_TIMEOUT_MS, maximumAge:5000 }
    );
  }).catch(async (e)=>{
    // v1.3.1: On flaky cellular GPS, fall back to last known location so the app still loads.
    const last = loadLastLocation();
    if (last) {
      if (statusEl) statusEl.textContent = "Using last location…";
      showErr("Location failed — using last known location");
      return { coords: { latitude: last.lat, longitude: last.lon, accuracy: last.accuracy }, __fromLast: true };
    }
    // No last-known location: use demo area and prompt user to enable location.
    if (statusEl) statusEl.textContent = "Demo";
    showErr(`Showing ${DEMO_LOC.label} (${DEMO_LOC.zip}) as a demo location — enable location to see flights near you.`);
    return { coords: { latitude: DEMO_LOC.lat, longitude: DEMO_LOC.lon, accuracy: 25000 }, __fromDemo: true };
  });

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  // v1.3.1: persist last good location to survive cellular GPS flakiness
  // Do not overwrite last-known location with the demo fallback.
  if (!pos?.__fromDemo) {
    saveLastLocation(lat, lon, pos?.coords?.accuracy);
  }
  
  // Demo / location mode badge (mobile clarity)
  const demoBadge = document.getElementById("demoBadge");
  if (demoBadge) {
    if (pos?.__fromDemo) {
      demoBadge.textContent = `Demo: ${DEMO_LOC.label} (${DEMO_LOC.zip})`;
      demoBadge.classList.remove("hidden");
    } else {
      demoBadge.classList.add("hidden");
    }
  }
const bb = bboxAround(lat, lon);

  if (statusEl) statusEl.textContent = "Radar…";

  let nextAllowedAt = 0;
  let inFlight = false;

  // state for rendering
  let lastTop = [];
  let lastPrimary = null;
  let lastSecondary = null;
  let lastRadarMeta = { count: 0, showing: 0 };

  function renderAll(){
    if (!lastPrimary) return;
    renderPrimary(lastPrimary, lastRadarMeta);
    if (isKiosk()) {
      renderSecondary(lastSecondary);
    } else {
      renderSecondary(null);
      renderList(lastTop);
    }
  }

  // Re-render on rotation so portrait formatting updates instantly
  try {
    window.addEventListener("orientationchange", () => setTimeout(renderAll, 50));
    window.addEventListener("resize", () => setTimeout(renderAll, 50));
  } catch {}

  function queueTopEnrichment(top){
    // cached-only for list (budgets are 0)
    for (const f of top) applyCachedEnrichment(f);

    let aircraftBudget = LIST_AIRCRAFT_BUDGET;
    for (const f of top) {
      if (aircraftBudget <= 0) break;
      const k = cacheKeyForFlight(f);
      const cached = enrichCache.get(k) || {};
      if (!f.modelText && !cached.modelText) {
        queueEnrich("aircraft", f);
        aircraftBudget--;
      }
    }

    let routeBudget = LIST_ROUTE_BUDGET;
    for (const f of top) {
      if (routeBudget <= 0) break;
      const k = cacheKeyForFlight(f);
      const cached = enrichCache.get(k) || {};
      if (!f.routeText && !cached.routeText) {
        queueEnrich("route", f);
        routeBudget--;
      }
    }

    pumpEnrichment(renderAll);
  }

  async function tick(){
    try { if (document.hidden) return; } catch {}
    if (inFlight) return;

    const now = Date.now();
    if (now < nextAllowedAt) {
      if (statusEl) statusEl.textContent = "Backoff…";
      return;
    }

    inFlight = true;

    try{
      const url = new URL(`${API_BASE}/api/opensky/states`);
      Object.entries(bb).forEach(([k,v])=>url.searchParams.set(k,v));

      const data = await fetchJSON(url.toString(), STATES_TIMEOUT_MS);
      const states = Array.isArray(data?.states) ? data.states : [];

      lastRadarMeta = { count: states.length, showing: Math.min(states.length, 5) };

      if (!states.length){
        if (statusEl) statusEl.textContent = "No flights";
        lastTop = [];
        lastPrimary = {callsign:"—", icao24:"—"};
        lastSecondary = null;
        renderAll();
        return;
      }

      const flights = states.map((s)=>{
        const icao24 = nm(s[0]).toLowerCase();
        const callsign = nm(s[1]);
        const country = nm(s[2]);
        const lon2 = (typeof s[5] === "number") ? s[5] : NaN;
        const lat2 = (typeof s[6] === "number") ? s[6] : NaN;
        const baroAlt = (typeof s[7] === "number") ? s[7] : NaN;
        const velocity = (typeof s[9] === "number") ? s[9] : NaN;
        const trueTrack = (typeof s[10] === "number") ? s[10] : NaN;
        const verticalRate = (typeof s[11] === "number") ? s[11] : NaN;
        const squawk = (s[14] != null) ? String(s[14]).trim() : "";
        const distanceMi = (Number.isFinite(lat2) && Number.isFinite(lon2)) ? haversineMi(lat, lon, lat2, lon2) : Infinity;

        return {
          icao24, callsign, country, baroAlt, velocity, trueTrack, verticalRate, squawk, distanceMi,
          routeText: undefined,
          modelText: undefined,
          airlineName: undefined,
          airlineGuess: guessAirline(callsign),
          modelHint: liveModelHintFromState(s),
        };
      }).filter(f => Number.isFinite(f.distanceMi)).sort((a,b)=>a.distanceMi-b.distanceMi);

      const shown = flights.filter(f => groupForFlight(f.callsign) === tier);
      lastTop = shown.slice(0,5);

      lastPrimary = lastTop[0] || flights[0];
      lastSecondary = lastTop[1] || null;

      for (const f of lastTop) applyCachedEnrichment(f);
      applyCachedEnrichment(lastPrimary);
      if (lastSecondary) applyCachedEnrichment(lastSecondary);

      if (statusEl) statusEl.textContent = isKiosk() ? "Kiosk" : "Live";
      renderAll();

      // Only enrich the closest flight (primary) — stability-gated (2 cycles) to prevent churn
      if (lastPrimary && lastPrimary.callsign) {
        const cs = normalizeCallsign(lastPrimary.callsign);
        if (cs) {
          if (primaryStableCs === cs) primaryStableCount++;
          else { primaryStableCs = cs; primaryStableCount = 1; }

          const k = cacheKeyForFlight(lastPrimary);
          const cached = enrichCache.get(k) || {};
          const needAircraft = !lastPrimary.modelText && !cached.modelText;
          const needRoute = !lastPrimary.routeText && !cached.routeText;

          const stableEnough = primaryStableCount >= 2;
          const nowMs = Date.now();
          const sameAsLastQueue = lastEnrichQueuedKey === k;
          const recentQueue = nowMs - lastEnrichQueuedAt < 60_000;

          const withinEnrichRange = Number.isFinite(lastPrimary.distanceMi) && lastPrimary.distanceMi <= ENRICH_MAX_MI;

          if (withinEnrichRange && stableEnough && (needAircraft || needRoute) && !(sameAsLastQueue && recentQueue)) {
            if (needAircraft) queueEnrich("aircraft", lastPrimary);
            if (needRoute) queueEnrich("route", lastPrimary);

            lastEnrichQueuedKey = k;
            lastEnrichQueuedAt = nowMs;
          }
        }
      }

      // List stays cached-only
      queueTopEnrichment(lastTop);

      pumpEnrichment(renderAll);

    } catch(e){
      const msg = String(e?.message || e);

      if (/^HTTP 429:/i.test(msg) || /Too many requests/i.test(msg)) {
        nextAllowedAt = Date.now() + BACKOFF_429_MS;
        if (statusEl) statusEl.textContent = "Rate limited";
        return;
      }

      if (statusEl) statusEl.textContent = isKiosk() ? "Kiosk" : "Live";
    } finally {
      inFlight = false;
    }
  }

  await tick();
  const pollMs = isKiosk() ? POLL_KIOSK_MS : POLL_MAIN_MS;
  setInterval(tick, pollMs);
}

// Run after DOM is ready (prevents "Booting..." stuck if script loads before elements exist)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}