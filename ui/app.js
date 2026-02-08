// FlightWall UI (v170)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v181";

/**
 * ✅ Rate-limit protection:
 * - main mode polls slower
 * - kiosk polls even slower
 * - if OpenSky 429 happens, back off for 60s
 * - ✅ inFlight guard prevents overlapping polls (important on iOS/cellular)
 * - ✅ pause polling when tab is hidden (reduces background hits)
 */
const POLL_MAIN_MS = 8000;   // was 3500
const POLL_KIOSK_MS = 12000; // kiosk is display-only; keep it lighter
const BACKOFF_429_MS = 60000;

const enrichCache = new Map();
const enrichInFlight = new Set();

// Enrich up to this many *list* entries per poll cycle (primary still enriched separately).
// Keeps credit usage predictable while still filling in the 5-card list quickly across polls.
const ENRICH_LIST_MAX_FLIGHTS_PER_TICK = 2;

const $ = (id) => document.getElementById(id);
const errBox = $("errBox");

function showErr(msg){
  const m = String(msg||"");
  if (/AbortError/i.test(m) || /fetch aborted/i.test(m) || /aborted/i.test(m)) return;
  try {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
  } catch {}
}
window.addEventListener("error", (e)=>showErr("JS error: " + (e?.message || e)));
window.addEventListener("unhandledrejection", (e)=>showErr("Promise rejection: " + (e?.reason?.message || e?.reason || e)));

function nm(s){ return (s ?? "").toString().trim(); }

function haversineMi(lat1, lon1, lat2, lon2){
  const R = 3958.7613;
  const toRad = (d)=>d*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function headingToText(deg){
  if (!Number.isFinite(deg)) return "—";
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  const idx = Math.round((((deg%360)+360)%360) / 45) % 8;
  return dirs[idx] + ` (${Math.round(deg)}°)`;
}

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
    if (!res.ok) {
      // include status in message so tick() can backoff on 429
      throw new Error(`HTTP ${res.status}: ${text.slice(0,220)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

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

  if ($("alt")) $("alt").textContent = fmtAlt(f.baroAlt);
  if ($("spd")) $("spd").textContent = fmtSpd(f.velocity);
  if ($("dist")) $("dist").textContent = fmtMi(f.distanceMi);
  if ($("dir")) $("dir").textContent = headingToText(f.trueTrack);

  if ($("route")) $("route").textContent = f.routeText || "—";
  if ($("model")) $("model").textContent = f.modelText || "—";

  // If you removed “Showing” in HTML, this line can be simplified later — leaving as-is for compatibility.
  if ($("radarLine")) $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;
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

  $("route2").textContent = f.routeText || "—";
  $("model2").textContent = f.modelText || "—";

  $("dist2").textContent = fmtMi(f.distanceMi);
  $("alt2").textContent = fmtAlt(f.baroAlt);
  $("spd2").textContent = fmtSpd(f.velocity);
  $("dir2").textContent = headingToText(f.trueTrack);
}

function renderList(list){
  const el = $("list");
  if (!el) return;
  el.innerHTML = "";
  list.forEach((f)=>{
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="l">
        <div class="cs">${f.callsign || "—"}</div>
        <div class="rt">${f.routeText || "—"}</div>
        <div class="m">${f.modelText || "—"}</div>
      </div>
      <div class="r">
        <div class="d">${fmtMi(f.distanceMi)}</div>
        <div class="a">${fmtAlt(f.baroAlt)}</div>
      </div>
    `;
    el.appendChild(row);
  });
}

function normalizeCallsign(cs){
  return nm(cs).replace(/\s+/g,"").toUpperCase();
}

// Grouping: A=Airlines, B=Other (baseline behavior)
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

async function enrichRoute(primary){
  const cs = normalizeCallsign(primary.callsign);
  if (!cs) return;
  try {
    const data = await fetchJSON(`${API_BASE}/flight/${encodeURIComponent(cs)}`, 9000);
    if (data && data.ok) {
      primary.routeText = data.route || primary.routeText;
      primary.airlineName = data.airlineName || data.airline || primary.airlineName;
      primary.airlineGuess = primary.airlineGuess || guessAirline(primary.callsign);
      if (!primary.modelText && (data.aircraftModel || data.aircraft?.model || data.aircraft?.modelName)) {
        primary.modelText = (data.aircraftModel || data.aircraft?.model || data.aircraft?.modelName);
      }
      const k = `${nm(primary.icao24).toLowerCase()}|${cs}`;
      enrichCache.set(k, { ...(enrichCache.get(k) || {}), routeText: primary.routeText, airlineName: primary.airlineName, airlineGuess: primary.airlineGuess, modelText: primary.modelText });
    }
  } catch {}
}

async function enrichAircraft(primary){
  const hex = nm(primary.icao24).toLowerCase();
  if (!hex) return;
  try {
    const data = await fetchJSON(`${API_BASE}/aircraft/icao24/${encodeURIComponent(hex)}`, 9000);
    // Worker may return either:
    //  - { ok:true, found:false, icao24 } (no data)
    //  - { ok:true, ...airframeFields }
    //  - raw AeroDataBox JSON (older cache); we still try to read it safely
    if (data && (data.ok === true || data.ok == null)) {
      if (data.found === false) return;

      // Prefer human-friendly labels when available
      const typeName = nm(data.typeName);
      const line = nm(data.productionLine);
      const model = nm(data.model) || nm(data.modelName);
      const code = nm(data.modelCode) || nm(data.icaoCode) || nm(data.iataCodeShort);
      const mfg = nm(data.manufacturer);

      // Build a readable string without being too long
      let out = "";
      if (typeName) out = typeName;
      else if (mfg || model) out = (mfg ? (mfg + " ") : "") + (model || "—");
      else if (line) out = line;
      else out = "—";

      if (code && out && !out.includes(code) && out !== "—") out += ` (${code})`;

      primary.modelText = out;
      const cs = normalizeCallsign(primary.callsign);
      const k = `${hex}|${cs}`;
      enrichCache.set(k, { ...(enrichCache.get(k) || {}), modelText: primary.modelText });
    }
  } catch {}
}

/* ✅ ROBUST kiosk detection:
   - /kiosk.html
   - ?kiosk=1
   - body.kiosk
   - window.__KIOSK_MODE__ = true
*/
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

  let lastPrimaryKey = "";

  // Enrich the 5 nearby entries (route + aircraft) gradually across polls.
  // This uses the Worker cache-first behavior, and we cap how many list flights we attempt per tick.
  function kickListEnrichment(top, primary, secondary, radarMeta){
    if (!Array.isArray(top) || !top.length) return;

    // Don’t spam: limit how many *flights* we try to enrich per poll.
    let budget = ENRICH_LIST_MAX_FLIGHTS_PER_TICK;

    const tasks = [];
    for (const f of top) {
      if (budget <= 0) break;

      const cs = normalizeCallsign(f.callsign);
      const hex = nm(f.icao24).toLowerCase();
      const k = `${hex}|${cs}`;

      // If we already have both, skip.
      const cached = enrichCache.get(k) || {};
      const needsRoute = !(f.routeText || cached.routeText);
      const needsModel = !(f.modelText || cached.modelText);
      if (!needsRoute && !needsModel) continue;

      // Avoid duplicate in-flight enrichment for the same flight in the same session.
      if (enrichInFlight.has(k)) continue;
      enrichInFlight.add(k);
      budget -= 1;

      tasks.push(
        Promise.allSettled([
          needsRoute ? enrichRoute(f) : Promise.resolve(),
          needsModel ? enrichAircraft(f) : Promise.resolve(),
        ]).finally(()=>{
          enrichInFlight.delete(k);
        })
      );
    }

    if (!tasks.length) return;

    Promise.allSettled(tasks).then(()=>{
      // Re-apply cache → objects, then re-render what’s visible.
      for (const f of top) {
        const k = `${nm(f.icao24).toLowerCase()}|${normalizeCallsign(f.callsign)}`;
        const cached = enrichCache.get(k);
        if (cached) Object.assign(f, cached);
      }

      // Primary/secondary may be references from `top`; render again to reflect new fields.
      renderPrimary(primary, radarMeta);
      if (isKiosk()) {
        renderSecondary(secondary);
      } else {
        renderList(top);
      }
    });
  }

  // ✅ Backoff gate
  let nextAllowedAt = 0;

  // ✅ Prevent overlapping polls (setInterval can stack on slow networks)
  let inFlight = false;

  async function tick(){
    // Pause when tab is hidden (prevents background spam)
    try { if (document.hidden) return; } catch {}

    if (inFlight) return;

    const now = Date.now();
    if (now < nextAllowedAt) {
      if (statusEl) statusEl.textContent = `Backoff…`;
      return;
    }

    inFlight = true;
    try{
      const url = new URL(`${API_BASE}/opensky/states`);
      Object.entries(bb).forEach(([k,v])=>url.searchParams.set(k,v));
      const data = await fetchJSON(url.toString(), 9000);
      const states = Array.isArray(data?.states) ? data.states : [];

      const radarMeta = { count: states.length, showing: Math.min(states.length, 5) };

      if (!states.length){
        if (statusEl) statusEl.textContent = "No flights";
        renderPrimary({callsign:"—", icao24:"—"}, radarMeta);
        renderSecondary(null);
        if ($("list")) $("list").innerHTML = "";
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

        return { icao24, callsign, country, baroAlt, velocity, trueTrack, distanceMi, routeText:undefined, modelText:undefined, airlineName:undefined, airlineGuess:guessAirline(callsign) };
      }).filter(f => Number.isFinite(f.distanceMi)).sort((a,b)=>a.distanceMi-b.distanceMi);

      const shown = flights.filter(f => groupForFlight(f.callsign) === tier);
      const top = shown.slice(0,5);

      const primary = top[0] || flights[0];
      const secondary = top[1] || null;

      for (const f of top){
        const k = `${f.icao24}|${normalizeCallsign(f.callsign)}`;
        const cached = enrichCache.get(k);
        if (cached) Object.assign(f, cached);
      }

      if (statusEl) statusEl.textContent = isKiosk() ? "Kiosk" : "Live";
      renderPrimary(primary, radarMeta);

      if (isKiosk()) {
        renderSecondary(secondary);
      } else {
        renderSecondary(null);
        renderList(top);
      }

      // ✅ Also enrich the top 5 list (gradually) so routes + aircraft populate below.
      kickListEnrichment(top, primary, secondary, radarMeta);

      const key = `${primary.icao24}|${normalizeCallsign(primary.callsign)}`;
      const cachedPrimary = enrichCache.get(key);
      const needsRoute = !cachedPrimary || !cachedPrimary.routeText;
      const needsAircraft = !cachedPrimary || !cachedPrimary.modelText;

      if (key && (key !== lastPrimaryKey || needsRoute || needsAircraft)){
        lastPrimaryKey = key;

        Promise.allSettled([
          needsRoute ? enrichRoute(primary) : Promise.resolve(),
          needsAircraft ? enrichAircraft(primary) : Promise.resolve(),
        ]).then(()=>{
          const updated = enrichCache.get(key);
          if (updated) Object.assign(primary, updated);
          renderPrimary(primary, radarMeta);

          if (isKiosk()) {
            if (secondary) {
              const k2 = `${secondary.icao24}|${normalizeCallsign(secondary.callsign)}`;
              const u2 = enrichCache.get(k2);
              if (u2) Object.assign(secondary, u2);
            }
            renderSecondary(secondary);
          } else {
            renderList(top.map(f=>{
              const k2 = `${f.icao24}|${normalizeCallsign(f.callsign)}`;
              const u2 = enrichCache.get(k2);
              return u2 ? Object.assign(f, u2) : f;
            }));
          }
        });
      }
    } catch(e){
      const msg = String(e?.message || e);

      // ✅ If OpenSky rate limits us, back off hard
      if (/^HTTP 429:/i.test(msg) || /Too many requests/i.test(msg)) {
        nextAllowedAt = Date.now() + BACKOFF_429_MS;
        if (statusEl) statusEl.textContent = "Rate limited";
        showErr("OpenSky rate limited (429). Backing off for 60s.");
        return;
      }

      if (statusEl) statusEl.textContent = "Radar error";
      showErr(msg);
    } finally {
      inFlight = false;
    }
  }

  await tick();

  // ✅ Use different poll interval based on mode (main vs kiosk)
  const pollMs = isKiosk() ? POLL_KIOSK_MS : POLL_MAIN_MS;
  setInterval(tick, pollMs);
}

main();