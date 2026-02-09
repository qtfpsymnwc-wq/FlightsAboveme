// FlightsAboveMe UI
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v183";

// Poll cadence
const POLL_MAIN_MS = 8000;
const POLL_KIOSK_MS = 12000;
const BACKOFF_429_MS = 60000;

// Enrichment timeouts (keep short so UI never “hangs” waiting on metadata)
const ENRICH_TIMEOUT_MS = 4500;

// Enrichment budgets (per “cycle”)
// v1.2.9+: only enrich the closest flight
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
window.addEventListener("error", (e)=>showErr("JS error: " + (e?.message || e)));
window.addEventListener("unhandledrejection", (e)=>showErr("Promise rejection: " + (e?.reason?.message || e?.reason || e)));

const nm = (v) => (v ?? "").toString().trim();

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
  const t = nm(routeText) || "—";
  if (isKiosk() && isPortrait()) return routeCodesOnly(t);
  return t;
}

// -------------------- Rendering --------------------

function renderPrimary(f, radarMeta){
  if ($("callsign")) $("callsign").textContent = f.callsign || "—";
  if ($("icao24")) $("icao24").textContent = f.icao24 || "—";

  const inferredAirline = f.airlineName || f.airlineGuess || guessAirline(f.callsign);
  const countryFallback = (f.country && f.country !== "United States") ? f.country : "—";
  if ($("airline")) $("airline").textContent = inferredAirline || countryFallback;

  const img = $("airlineLogo");
  if (img) {
    const candidates = logoCandidatesForFlight(f);
    let i = 0;
    img.onerror = () => { i += 1; if (i < candidates.length) img.src = candidates[i]; };
    img.src = candidates[0];
    img.classList.remove("hidden");
  }

  const compactStats = (isKiosk() && isPortrait() && window.innerWidth <= 430);

  if ($("alt")) $("alt").textContent = compactStats ? fmtAltCompact(f.baroAlt) : fmtAlt(f.baroAlt);
  if ($("spd")) $("spd").textContent = compactStats ? fmtSpdCompact(f.velocity) : fmtSpd(f.velocity);
  if ($("dist")) $("dist").textContent = compactStats ? fmtMiCompact(f.distanceMi) : fmtMi(f.distanceMi);

  if ($("dir")) $("dir").textContent = headingToText(
    f.trueTrack,
    { short: (isKiosk() && isPortrait()) }
  );

  if ($("route")) $("route").textContent = formatRouteForDisplay(f.routeText || "—");
  if ($("model")) $("model").textContent = f.modelText || "—";

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

  const inferredAirline = f.airlineName || f.airlineGuess || guessAirline(f.callsign);
  const countryFallback = (f.country && f.country !== "United States") ? f.country : "—";
  $("airline2").textContent = inferredAirline || countryFallback;

  const img2 = $("airlineLogo2");
  if (img2) {
    const candidates = logoCandidatesForFlight(f);
    let i = 0;
    img2.onerror = () => { i += 1; if (i < candidates.length) img2.src = candidates[i]; };
    img2.src = candidates[0];
    img2.classList.remove("hidden");
  }

  $("route2").textContent = formatRouteForDisplay(f.routeText || "—");
  $("model2").textContent = f.modelText || "—";

  const compactStats = (isKiosk() && isPortrait() && window.innerWidth <= 430);

  $("dist2").textContent = compactStats ? fmtMiCompact(f.distanceMi) : fmtMi(f.distanceMi);
  $("alt2").textContent = compactStats ? fmtAltCompact(f.baroAlt) : fmtAlt(f.baroAlt);
  $("spd2").textContent = compactStats ? fmtSpdCompact(f.velocity) : fmtSpd(f.velocity);

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
    const data = await fetchJSON(`${API_BASE}/flight/${encodeURIComponent(cs)}`, ENRICH_TIMEOUT_MS);
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
    const data = await fetchJSON(`${API_BASE}/aircraft/icao24/${encodeURIComponent(hex)}`, ENRICH_TIMEOUT_MS);
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
      { enableHighAccuracy:true, timeout:12000, maximumAge:5000 }
    );
  }).catch((e)=>{
    if (statusEl) statusEl.textContent = "Location failed";
    showErr(String(e.message || e));
    throw e;
  });

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
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
      const url = new URL(`${API_BASE}/opensky/states`);
      Object.entries(bb).forEach(([k,v])=>url.searchParams.set(k,v));

      const data = await fetchJSON(url.toString(), 9000);
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
        const distanceMi = (Number.isFinite(lat2) && Number.isFinite(lon2)) ? haversineMi(lat, lon, lat2, lon2) : Infinity;

        return {
          icao24, callsign, country, baroAlt, velocity, trueTrack, distanceMi,
          routeText: undefined,
          modelText: undefined,
          airlineName: undefined,
          airlineGuess: guessAirline(callsign),
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

      // Only enrich the closest flight (primary)
      queueEnrich("aircraft", lastPrimary);
      queueEnrich("route", lastPrimary);

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

main();