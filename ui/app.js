// FlightWall UI v178
// Closest flight overhead - Live ADS-B

const UI_VERSION = "v178";
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const POLL_MS = 3500;

const $ = (id) => document.getElementById(id);
const nm = (x) => (typeof x === "string" ? x.trim() : "");

function normalizeCallsign(cs){
  return nm(cs).replace(/\s+/g, "").toUpperCase();
}

function haversineMi(lat1, lon1, lat2, lon2){
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function bboxAround(centerLat, centerLon, radiusMi = 75){
  // Roughly 1 degree latitude ~= 69 miles
  const dLat = radiusMi / 69;
  const dLon = radiusMi / (69 * Math.cos((centerLat * Math.PI)/180));
  return {
    lamin: String(centerLat - dLat),
    lamax: String(centerLat + dLat),
    lomin: String(centerLon - dLon),
    lomax: String(centerLon + dLon),
  };
}

function fmtMi(n){
  if (!Number.isFinite(n)) return "—";
  return n < 10 ? n.toFixed(1) : Math.round(n).toString();
}

function fmtAltFt(m){
  if (!Number.isFinite(m)) return "—";
  return Math.round(m * 3.28084).toLocaleString();
}

function fmtMphFromMS(ms){
  if (!Number.isFinite(ms)) return "—";
  return Math.round(ms * 2.236936).toLocaleString();
}

function fmtDir(deg){
  if (!Number.isFinite(deg)) return "—";
  const d = ((deg % 360) + 360) % 360;
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  const idx = Math.round(d / 45) % 8;
  return `${dirs[idx]} (${Math.round(d)}°)`;
}

function showErr(msg){
  const el = $("errBox");
  if (!el) return;
  const s = String(msg || "");
  // Ignore common, harmless abort noise (new poll starts, previous fetch cancelled)
  if (/aborted/i.test(s) || /AbortError/i.test(s)) return;
  el.textContent = s;
  el.classList.toggle("hidden", !s);
}

async function fetchJSON(url, timeoutMs){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(url, {
      headers: { "accept": "application/json" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// --- Airline classification (Tier A vs Tier B) ---
// Tier A = passenger airlines + regionals (no cargo/private/military)
// Tier B = everything else (includes cargo/private/military/government)

const PASSENGER_PREFIXES = new Set([
  // US majors / LCC
  "AAL","DAL","UAL","SWA","JBU","FFT","NKS","ASA","SKW","ENY","RPA","EDV","GJS","JIA","PDT","ASH","AWI","QXE","CPZ","EJA",
  "AAY","VRD","B6","WJA", // (some non-ICAO-ish; harmless)
  // Common internationals
  "BAW","AFR","DLH","KLM","ACA","EIN","SWR","IBE","TAP","SAS","FIN","AUA","LOT","ITY","KAL","AAR","JAL","ANA","SIA","QFA","UAE","ETD","QTR",
]);

const REGIONAL_HINTS = ["SKW","ENY","RPA","EDV","GJS","JIA","ASH","PDT","AWI","QXE","CPZ"];

const CARGO_PREFIXES = new Set([
  "FDX","UPS","ABX","GTI","KFS","MRT","CGN","PAC","BCS","DHL","CLX","NCR","AJT","ATN","POE","POD","CKS","AAL", // NOTE: keep majors out in logic below
]);

const MIL_GOV_PREFIXES = new Set([
  "RCH","CNV","PAT","SAM","NAV","AF1","VMO","VVV","SPAR","KING","HOMER","REACH","COBRA","DUKE","NATO",
]);

function callsignPrefix(cs){
  const c = normalizeCallsign(cs);
  if (!c) return "";
  // Grab leading letters (up to 4) until first digit
  const m = c.match(/^[A-Z]{1,4}/);
  return m ? m[0] : "";
}

function isLikelyNNumber(cs){
  return /^N\d/i.test(normalizeCallsign(cs));
}

function isCargo(cs){
  const p = callsignPrefix(cs);
  if (!p) return false;
  // Some cargo carriers overlap letters with passenger; keep passenger list taking precedence.
  if (PASSENGER_PREFIXES.has(p)) return false;
  return CARGO_PREFIXES.has(p);
}

function isMilGov(cs){
  const p = callsignPrefix(cs);
  return MIL_GOV_PREFIXES.has(p);
}

function isTierAFlight(cs){
  const p = callsignPrefix(cs);
  if (!p) return false;
  if (PASSENGER_PREFIXES.has(p)) return true;
  // Treat these as regionals even if not in the big list.
  if (REGIONAL_HINTS.includes(p)) return true;
  return false;
}

// --- Enrichment caching (route + aircraft type) ---
const enrichCache = new Map();

async function enrichRoute(flight){
  const callsign = normalizeCallsign(flight.callsign);
  if (!callsign) return;
  try {
    const data = await fetchJSON(`${API_BASE}/route?callsign=${encodeURIComponent(callsign)}`, 9000);
    if (!data?.ok) return;
    const key = `${flight.icao24}|${callsign}`;
    enrichCache.set(key, {
      routeText: data.route || data.routeText || undefined,
      airlineName: data.airlineName || undefined,
      registration: data.registration || undefined,
    });
  } catch (e) {
    showErr(e);
  }
}

async function enrichAircraft(flight){
  const callsign = normalizeCallsign(flight.callsign);
  if (!callsign) return;
  try {
    const data = await fetchJSON(`${API_BASE}/aircraft?callsign=${encodeURIComponent(callsign)}`, 9000);
    if (!data?.ok) return;
    const key = `${flight.icao24}|${callsign}`;
    enrichCache.set(key, {
      modelText: data.typeName || data.model || data.modelText || undefined,
      registration: data.registration || undefined,
      airlineName: data.airlineName || undefined,
    });
  } catch (e) {
    showErr(e);
  }
}

function pickAirlineLabel(f){
  return f.airlineName || (isTierAFlight(f.callsign) ? callsignPrefix(f.callsign) : "—");
}

function renderPrimary(f, meta){
  $("cs").textContent = f.callsign || "—";
  $("route").textContent = f.routeText || "—";
  $("model").textContent = f.modelText || "—";

  $("icao24").textContent = f.icao24 || "—";
  $("airline").textContent = pickAirlineLabel(f);

  $("alt").textContent = fmtAltFt(f.baroAlt);
  $("spd").textContent = fmtMphFromMS(f.velocity);
  $("dist").textContent = fmtMi(f.distanceMi);
  $("dir").textContent = fmtDir(f.trueTrack);

  const radar = $("radar");
  if (radar) {
    const count = meta?.count ?? "—";
    const showing = meta?.showing ?? "—";
    radar.textContent = `Radar: ${count} flights • Showing: ${showing}`;
  }
  const footer = $("footer");
  if (footer) {
    footer.textContent = `UI ${UI_VERSION} • API ${meta?.apiVersion || "?"}`;
  }
}

function renderList(list){
  const el = $("list");
  if (!el) return;
  el.innerHTML = "";
  for (const f of list) {
    const row = document.createElement("div");
    row.className = "listRow";

    const left = document.createElement("div");
    left.className = "listLeft";
    left.textContent = f.callsign || "—";

    const right = document.createElement("div");
    right.className = "listRight";
    right.textContent = `${fmtMi(f.distanceMi)} mi • ${fmtAltFt(f.baroAlt)} ft • ${fmtMphFromMS(f.velocity)} mph`;

    row.appendChild(left);
    row.appendChild(right);
    el.appendChild(row);
  }
}

async function main(){
  // Controls
  const tierSegment = $("tierSegment");
  const infoBtn = $("tierInfoBtn");
  const modal = $("tierInfo");
  const closeBtn = $("tierInfoClose");

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
      const btn = e.target?.closest ? e.target.closest("button[data-tier]") : null;
      if (!btn) return;
      tier = (btn.getAttribute("data-tier") || "A").toUpperCase();
      if (tier !== "A" && tier !== "B") tier = "A";
      localStorage.setItem("fw_tier", tier);
      syncTierButtons();
      tick();
    });
    syncTierButtons();
  }

  const openModal = ()=>{ if (modal) modal.classList.remove("hidden"); };
  const closeModal = ()=>{ if (modal) modal.classList.add("hidden"); };
  infoBtn?.addEventListener("click", openModal);
  closeBtn?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (e)=>{ if (e.target === modal) closeModal(); });

  let apiVersion = "?";
  try {
    const h = await fetchJSON(`${API_BASE}/health`, 7000);
    apiVersion = h?.version || "?";
  } catch {}

  // Geolocation
  $("statusText").textContent = "Locating…";
  const pos = await new Promise((resolve, reject)=>{
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 });
  }).catch((e)=>{
    $("statusText").textContent = "Location failed";
    showErr(e?.message || e);
    throw e;
  });

  const lat0 = pos.coords.latitude;
  const lon0 = pos.coords.longitude;
  const bb = bboxAround(lat0, lon0);

  $("statusText").textContent = "Radar…";

  let inFlight = false;
  let lastPrimaryKey = "";

  async function tick(){
    if (inFlight) return;
    inFlight = true;
    try {
      const url = new URL(`${API_BASE}/opensky/states`);
      Object.entries(bb).forEach(([k,v])=>url.searchParams.set(k,v));
      const data = await fetchJSON(url.toString(), 9000);
      const states = Array.isArray(data?.states) ? data.states : [];

      // Map states -> flights
      let flights = states.map((s)=>{
        const icao24 = nm(s[0]).toLowerCase();
        const callsign = nm(s[1]);
        const lon2 = (typeof s[5] === "number") ? s[5] : NaN;
        const lat2 = (typeof s[6] === "number") ? s[6] : NaN;
        const baroAlt = (typeof s[7] === "number") ? s[7] : NaN;
        const velocity = (typeof s[9] === "number") ? s[9] : NaN;
        const trueTrack = (typeof s[10] === "number") ? s[10] : NaN;
        const distanceMi = (Number.isFinite(lat2) && Number.isFinite(lon2)) ? haversineMi(lat0, lon0, lat2, lon2) : Infinity;
        return {
          icao24,
          callsign,
          lat: lat2,
          lon: lon2,
          baroAlt,
          velocity,
          trueTrack,
          distanceMi,
          routeText: undefined,
          modelText: undefined,
          registration: undefined,
          airlineName: undefined,
        };
      }).filter(f => Number.isFinite(f.distanceMi));

      // Tier filtering
      if (tier === "A") {
        flights = flights.filter((f)=>{
          const cs = normalizeCallsign(f.callsign);
          if (!cs) return false;
          if (isLikelyNNumber(cs)) return false;
          if (isMilGov(cs)) return false;
          if (isCargo(cs)) return false;
          return isTierAFlight(cs);
        });
      }

      flights.sort((a,b)=>a.distanceMi-b.distanceMi);

      const radarMeta = {
        count: flights.length,
        showing: Math.min(flights.length, 5),
        apiVersion,
      };

      if (!flights.length) {
        $("statusText").textContent = "No flights";
        renderPrimary({callsign:"—", icao24:"—"}, radarMeta);
        $("list").innerHTML = "";
        return;
      }

      const primary = flights[0];
      const top5 = flights.slice(0,5);

      // Apply cached enrichments so they don't flash + disappear.
      for (const f of top5) {
        const k = `${f.icao24}|${normalizeCallsign(f.callsign)}`;
        const cached = enrichCache.get(k);
        if (cached) Object.assign(f, cached);
      }

      $("statusText").textContent = "Live";
      showErr("");
      renderPrimary(primary, radarMeta);
      renderList(top5);

      const key = `${primary.icao24}|${normalizeCallsign(primary.callsign)}`;
      const cachedPrimary = enrichCache.get(key);
      const needsRoute = !cachedPrimary || !cachedPrimary.routeText;
      const needsAircraft = !cachedPrimary || !cachedPrimary.modelText;

      if (key && (key !== lastPrimaryKey || needsRoute || needsAircraft)) {
        lastPrimaryKey = key;
        Promise.allSettled([
          needsRoute ? enrichRoute(primary) : Promise.resolve(),
          needsAircraft ? enrichAircraft(primary) : Promise.resolve(),
        ]).then(()=>{
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
    } catch (e) {
      $("statusText").textContent = "Radar error";
      showErr(e?.message || e);
    } finally {
      inFlight = false;
    }
  }

  await tick();
  setInterval(tick, POLL_MS);
}

main();
