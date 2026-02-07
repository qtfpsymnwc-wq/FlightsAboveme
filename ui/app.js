// FlightWall UI (v170)
// Option A: Pages hosts this UI, Worker hosts API.
// Set API_BASE to your Worker domain. (No trailing slash)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v180";
const POLL_MS = 3500;

// Persist Aerodatabox + aircraft enrichments across refreshes.
// Keyed by icao24 + callsign to avoid "route flashes then disappears".
// Key: `${icao24}|${normalizedCallsign}`
const enrichCache = new Map();

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

function guessAirline(callsign){
  const c=(callsign||'').trim().toUpperCase();
  const p3=c.slice(0,3);
  const map={AAL:'American',ASA:'Alaska',DAL:'Delta',FFT:'Frontier',JBU:'JetBlue',NKS:'Spirit',SKW:'SkyWest',SWA:'Southwest',UAL:'United',AAY:'Allegiant',ENY:'Envoy',JIA:'PSA',RPA:'Republic',GJS:'GoJet',EDV:'Endeavor'};
  return map[p3]||null;
}

function airlineKeyFromCallsign(callsign){
  const cs=(callsign||'').trim().toUpperCase();
  // ICAO airline prefix is typically 3 letters (e.g., DAL1234)
  const m = cs.match(/^([A-Z]{3})/);
  return m ? m[1] : null;
}

function logoUrlForCallsign(callsign){
  const key = airlineKeyFromCallsign(callsign);
  const file = key ? `${key}.svg` : `_GENERIC.svg`;
  // cache-bust per UI version
  return `/assets/logos/${file}?v=${encodeURIComponent(UI_VERSION)}`;
}

// Resolve a logo key (typically ICAO, e.g. "AAL") into a static asset URL.
// Pages serves these from /assets/logos/<KEY>.svg (and /assets/logos/_GENERIC.svg).
function logoUrlForKey(key){
  const k = (key || "").toString().trim().toUpperCase();
  const file = k ? `${k}.svg` : `_GENERIC.svg`;
  return `/assets/logos/${file}?v=${encodeURIComponent(UI_VERSION)}`;
}

function logoUrlForFlight(f) {
  const key =
    (f?.airlineIcao || f?.operatorIcao || airlineKeyFromCallsign(f?.callsign || ""))?.toUpperCase?.() ||
    airlineKeyFromCallsign(f?.callsign || "");
  return logoUrlForKey(key);
}
function fmtMi(mi) {
  if (!Number.isFinite(mi)) return "—";
  return mi.toFixed(mi < 10 ? 1 : 0) + " mi";
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

async function fetchJSON(url, timeoutMs=8000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", credentials: "omit" });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,160)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

function renderPrimary(f, radarMeta){
  $("callsign").textContent = f.callsign || "—";
  $("icao24").textContent = f.icao24 || "—";
  // Prefer airline info; avoid showing OpenSky "country" (often just "United States") as the "Airline".
  const inferredAirline = f.airlineName || f.airlineGuess || guessAirline(f.callsign);
  const countryFallback = (f.country && f.country !== "United States") ? f.country : "—";
  $("airline").textContent = inferredAirline || countryFallback;

  // Airline logo (stored as static assets in Pages)
  try {
    const img = $("airlineLogo");
    if (img) {
      img.dataset.fallbackDone = "";
      img.onerror = () => {
        if (img.dataset.fallbackDone) return;
        img.dataset.fallbackDone = "1";
        img.src = logoUrlForKey("");
      };

      img.src = logoUrlForFlight(f);
      img.classList.remove('hidden');
      const key = (f.airlineIcao || f.operatorIcao || airlineKeyFromCallsign(f.callsign || "")) || "";
      img.alt = key ? `${key} logo` : 'Airline logo';
    }
  } catch (_) {}

  $("alt").textContent = fmtAlt(f.baroAlt);
  $("spd").textContent = fmtSpd(f.velocity);
  $("dist").textContent = fmtMi(f.distanceMi);
  $("dir").textContent = headingToText(f.trueTrack);

  $("route").textContent = f.routeText || "—";
  $("model").textContent = f.modelText || "—";
  // Registration is often unavailable in our data sources; we hide this line in the UI.

  $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;
}

function renderList(list){
  const el = $("list");
  el.innerHTML = "";
  list.forEach((f)=>{
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="left">
        <div class="cs">${f.callsign || "—"}</div>
        <div class="sub">${fmtMi(f.distanceMi)} • ${fmtAlt(f.baroAlt)} • ${fmtSpd(f.velocity)}</div>
      </div>
      <div class="badge">${f.icao24 || ""}</div>
    `;
    el.appendChild(row);
  });
}

function normalizeCallsign(cs){
  return nm(cs).replace(/\s+/g,"").toUpperCase();
}


// ----- Tier filtering -----
// Tier A: major passenger carriers (default)
// Tier B: expands to include regional partners + common cargo carriers
const TIER_A_PREFIXES = ["AAL","DAL","UAL","SWA","ASA","FFT","NKS","JBU","AAY"];
const TIER_B_EXTRA_PREFIXES = ["SKW","ENY","EDV","JIA","RPA","GJS","UPS","FDX"];
const TIER_ALL_PREFIXES = [...new Set([...TIER_A_PREFIXES, ...TIER_B_EXTRA_PREFIXES])];


// Grouping for B1:
// Tier A ("Airlines") = passenger + regionals (excludes cargo/private/military/gov/unknown)
// Tier B ("Other") = cargo + private/business + military/gov + unknown
const CARGO_PREFIXES = ["FDX","UPS","GTI","ABX","CKS","KAL","BOX","MXY","ATN"];
const MIL_GOV_PREFIXES = ["RCH","SAM","GAF","NOW","BAF","DAF","NAV","FNY","SPAR"];
const PRIVATE_PREFIXES = ["EJA","NJE","XOJ","LXJ","JTL","PJC","DCM","VJT"];

function isNNumberCallsign(cs){
  const c = normalizeCallsign(cs).replace(/\s+/g,"");
  return /^N\d/.test(c);
}

function isAirlinePattern(cs){
  const c = normalizeCallsign(cs).replace(/\s+/g,"").replace(/[^A-Z0-9]/g,"");
  return /^[A-Z]{3}\d{1,4}[A-Z]?$/.test(c);
}

function groupForFlight(cs){
  const p = callsignPrefix(cs);
  if (!p) return "B";
  // Any N-number or explicitly-known cargo/mil/private prefixes are "Other"
  if (isNNumberCallsign(cs)) return "B";
  if (CARGO_PREFIXES.includes(p) || MIL_GOV_PREFIXES.includes(p) || PRIVATE_PREFIXES.includes(p)) return "B";
  // "Airlines" are ONLY the prefixes we explicitly allow (majors + regionals).
  // This prevents private/charter/university operators like "OUA25" from being treated as airlines.
  if (TIER_ALL_PREFIXES.includes(p)) return "A";
  return "B";
}

function callsignPrefix(cs){
  const s = normalizeCallsign(cs);
  // Prefer 3-letter airline prefix when present (AAL1234, DAL2181, etc)
  const m = s.match(/^[A-Z]{3}/);
  if (m) return m[0];
  return s.slice(0,3);
}

function passesTier(cs, tier){
  const p = callsignPrefix(cs);
  if (!p) return false;
  if (tier === "B") return TIER_ALL_PREFIXES.includes(p);
  return TIER_A_PREFIXES.includes(p);
}


function cacheKeyForFlight(f){
  const hex = nm(f?.icao24).toLowerCase();
  const cs = normalizeCallsign(f?.callsign);
  return `${hex}|${cs}`;
}

function cacheMerge(k, patch){
  if (!k) return;
  const prev = enrichCache.get(k) || {};
  enrichCache.set(k, { ...prev, ...patch });
}

function cleanAirportName(s){
  return nm(s).replace(/\/+\s*$/,"").trim();
}

async function enrichRoute(primary){
  const cs = normalizeCallsign(primary.callsign);
  if (!cs) return;
  try {
    const data = await fetchJSON(`${API_BASE}/flight/${encodeURIComponent(cs)}`, 9000);
    if (data && data.ok) {
      const o = data.origin?.iata ? `${cleanAirportName(data.origin.municipalityName || data.origin.shortName || data.origin.name)} (${data.origin.iata})` : "";
      const d = data.destination?.iata ? `${cleanAirportName(data.destination.municipalityName || data.destination.shortName || data.destination.name)} (${data.destination.iata})` : "";
      primary.routeText = (o && d) ? `${o} → ${d}` : (data.route || "—");
      primary.airlineName = data.airlineName || data.airline || primary.airlineName;
      primary.airlineGuess = primary.airlineGuess || guessAirline(primary.callsign);
      primary.aircraftType = data.aircraftType || data.aircraft?.type || data.aircraft?.typeName || primary.aircraftType;
      if (!primary.modelText && (data.aircraftModel || data.aircraft?.model || data.aircraft?.modelName)) {
        primary.modelText = (data.aircraftModel || data.aircraft?.model || data.aircraft?.modelName);
      }

      // Persist across polls
      const k = `${nm(primary.icao24).toLowerCase()}|${cs}`;
      const prev = enrichCache.get(k) || {};
      enrichCache.set(k, {
        ...prev,
        routeText: primary.routeText,
        airlineName: primary.airlineName,
        airlineGuess: primary.airlineGuess,
        aircraftType: primary.aircraftType,
        modelText: primary.modelText,
        registration: primary.registration,
      });
    }
  } catch {}
}

async function enrichAircraft(primary){
  const hex = nm(primary.icao24).toLowerCase();
  if (!hex) return;
  try {
    const data = await fetchJSON(`${API_BASE}/aircraft/icao24/${encodeURIComponent(hex)}`, 9000);
    if (data && data.ok && data.found) {
      const mfg = nm(data.manufacturer);
      const model = nm(data.model);
      const code = nm(data.modelCode);
      primary.modelText = (mfg ? (mfg + " ") : "") + (model || "—") + (code && code !== model ? ` (${code})` : "");
      primary.registration = nm(data.registration) || primary.registration;

      // Persist across polls
      const cs = normalizeCallsign(primary.callsign);
      const k = `${hex}|${cs}`;
      const prev = enrichCache.get(k) || {};
      enrichCache.set(k, {
        ...prev,
        modelText: primary.modelText,
        registration: primary.registration,
      });
    }
  } catch {}
}

async function main(){
  $("statusText").textContent = "Locating…";

  // UI controls
  const tierSegment = document.getElementById("tierSegment");
  const showMilEl = document.getElementById("showMil");

  // Group info modal
  const groupInfoBtn = document.getElementById("groupInfoBtn");
  const groupInfo = document.getElementById("groupInfo");
  const groupInfoOk = document.getElementById("groupInfoOk");
  const groupInfoClose = document.getElementById("groupInfoClose");

  const openGroupInfo = ()=>{ if (groupInfo) groupInfo.hidden = false; };
  const closeGroupInfo = ()=>{ if (groupInfo) groupInfo.hidden = true; };

  if (groupInfoBtn) groupInfoBtn.addEventListener("click", openGroupInfo);
  if (groupInfoOk) groupInfoOk.addEventListener("click", closeGroupInfo);
  if (groupInfoClose) groupInfoClose.addEventListener("click", closeGroupInfo);

let tier = (localStorage.getItem("fw_tier") || "A").toUpperCase();
  if (tier !== "A" && tier !== "B") tier = "A";

  let showMil = localStorage.getItem("fw_showMil") === "1";

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
      tick(true);
    });
    syncTierButtons();
  }

  if (showMilEl) {
    showMilEl.checked = showMil;
    showMilEl.addEventListener("change", ()=>{
      showMil = !!showMilEl.checked;
      localStorage.setItem("fw_showMil", showMil ? "1" : "0");
      tick(true);
    });
  }

  let apiVersion = "?";
  try {
    const h = await fetchJSON(`${API_BASE}/health`, 6000);
    apiVersion = h?.version || "?";
  } catch {}

  const pos = await new Promise((resolve, reject)=>{
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      (p)=>resolve(p),
      (e)=>reject(new Error(e.message || "Location denied")),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
    );
  }).catch((e)=>{
    $("statusText").textContent = "Location failed";
    showErr(String(e.message || e));
    throw e;
  });

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const bb = bboxAround(lat, lon);

  $("statusText").textContent = "Radar…";

  let lastPrimaryKey = "";
  async function tick(){
    try {
      const url = new URL(`${API_BASE}/opensky/states`);
      Object.entries(bb).forEach(([k,v])=>url.searchParams.set(k,v));
      const data = await fetchJSON(url.toString(), 9000);
      const states = Array.isArray(data?.states) ? data.states : [];
      const radarMeta = {
        count: states.length,
        showing: Math.min(states.length, 5),
        apiVersion
      };

      if (!states.length) {
        $("statusText").textContent = "No flights";
        renderPrimary({callsign:"—", icao24:"—"}, radarMeta);
        $("list").innerHTML = "";
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
          icao24, callsign, country,
          lat: lat2, lon: lon2,
          baroAlt, velocity, trueTrack,
          distanceMi,
          // Enrichments (route/aircraft/airline) are applied from enrichCache
          routeText: undefined,
          modelText: undefined,
          registration: undefined,
          airlineName: undefined,
          airlineGuess: guessAirline(callsign),
        };
      }).filter(f => Number.isFinite(f.distanceMi)).sort((a,b)=>a.distanceMi-b.distanceMi);

      const shown = flights.filter(f => groupForFlight(f.callsign) === tier);
      const primary = shown[0] || flights[0];
      const top5 = shown.slice(0,5);

      if (!top5.length) {
        $("statusText").textContent = (tier === "A") ? "No airline flights nearby" : "No other traffic nearby";
        renderPrimary(primary, radarMeta);
        $("list").innerHTML = "";
        return;
      }

      // Apply cached enrichments so they don't "flash" and disappear on the next poll.
      for (const f of top5) {
        const k = `${f.icao24}|${normalizeCallsign(f.callsign)}`;
        const cached = enrichCache.get(k);
        if (cached) Object.assign(f, cached);
        // Always compute a best-effort airline guess
        if (!f.airlineGuess) f.airlineGuess = guessAirline(f.callsign);
      }

      $("statusText").textContent = "Live";
      renderPrimary(primary, radarMeta);
      renderList(top5);

      const key = `${primary.icao24}|${normalizeCallsign(primary.callsign)}`;
      const cachedPrimary = enrichCache.get(key);
      const needsRoute = !cachedPrimary || !cachedPrimary.routeText;
      const needsAircraft = !cachedPrimary || !cachedPrimary.modelText;

      // Only re-fetch when we don't have cached data (or primary changed).
      if (key && (key !== lastPrimaryKey || needsRoute || needsAircraft)) {
        lastPrimaryKey = key;
        Promise.allSettled([
          needsRoute ? enrichRoute(primary) : Promise.resolve(),
          needsAircraft ? enrichAircraft(primary) : Promise.resolve(),
        ]).then(()=>{
          // Re-apply cache (enrichRoute/enrichAircraft update it) then render.
          const updated = enrichCache.get(key);
          if (updated) Object.assign(primary, updated);
          renderPrimary(primary, radarMeta);
          renderList(top5.map(f=>{
            const k2 = `${f.icao24}|${normalizeCallsign(f.callsign)}`;
            const c2 = enrichCache.get(k2);
            return c2 ? Object.assign(f, c2) : f;
          }));
        });
      }
    } catch(e) {
      if (e && (e.name === "AbortError" || /aborted/i.test(String(e.message||e)))) { return; }
      $("statusText").textContent = "Radar error";
      showErr(String(e.message || e));
    }
  }

  await tick();
  setInterval(tick, POLL_MS);
}

main();