// FlightWall UI (v170)
// Option A: Pages hosts this UI, Worker hosts API.
// Set API_BASE to your Worker domain. (No trailing slash)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v180";
const POLL_MS = 3500;

// Allow overriding API base at runtime (handy for iOS testing)
// Example: window.FLIGHTS_API_BASE = "https://your-worker.workers.dev";
const API_BASE_OVERRIDE = (typeof window !== "undefined" && window.FLIGHTS_API_BASE) ? String(window.FLIGHTS_API_BASE) : "";

// Validate + normalize API base early so iOS Safari doesn't throw opaque "expected pattern" errors later.
function getApiBase(){
  const raw = (API_BASE_OVERRIDE || API_BASE || "").trim();
  if (!raw) throw new Error("API base URL is empty (API_BASE).");
  let u;
  try { u = new URL(raw); }
  catch { throw new Error(`API base URL is invalid: "${raw}"`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`API base URL must be http/https: "${raw}"`);
  // strip trailing slash for consistent joins
  return u.origin;
}
let API_ORIGIN = "";
try { API_ORIGIN = getApiBase(); } catch (e) { /* surfaced on first tick */ }

// Persist Aerodatabox + aircraft enrichments across refreshes.
// Keyed by icao24 + callsign to avoid "route flashes then disappears".
// Key: `${icao24}|${callsign}`
const enrichCache = new Map();

// If we have a selected flight, keep it sticky.
let selectedKey = null;

function $(id){ return document.getElementById(id); }

function fmtAlt(m){
  if (m == null) return "—";
  const ft = Math.round(m * 3.28084);
  return `${ft.toLocaleString()} ft`;
}

function fmtSpd(ms){
  if (ms == null) return "—";
  const mph = Math.round(ms * 2.23694);
  return `${mph.toLocaleString()} mph`;
}

function fmtDist(meters){
  if (meters == null) return "—";
  const mi = meters / 1609.344;
  return `${Math.round(mi)} mi`;
}

function fmtDir(deg){
  if (deg == null) return "—";
  const d = Math.round(deg);
  const dirs = ["N","NE","E","SE","S","SW","W","NW","N"];
  const idx = Math.round(d / 45);
  const label = dirs[idx] || "—";
  return `${label} (${d}°)`;
}

function guessAirline(callsign){
  // legacy placeholder; server-side logic should handle this.
  if (!callsign) return "";
  return callsign.trim().slice(0,3).toUpperCase();
}

function setLogo(code){
  const img = $("airlineLogo");
  if (!img) return;

  const safe = (code || "").trim().toUpperCase();
  if (!safe) {
    img.classList.add("hidden");
    img.removeAttribute("src");
    return;
  }

  img.classList.remove("hidden");
  img.dataset.fallbackDone = "";
  img.onerror = () => {
    if (img.dataset.fallbackDone) return;
    img.dataset.fallbackDone = "1";
    img.src = "./assets/logos/_GENERIC.svg";
  };
  img.src = `./assets/logos/${safe}.svg`;
}

function pickBestFlight(list){
  if (!Array.isArray(list) || list.length === 0) return null;
  // prefer selectedKey if still present
  if (selectedKey) {
    const found = list.find(f => `${f.icao24}|${(f.callsign||"").trim()}` === selectedKey);
    if (found) return found;
  }
  // else pick nearest
  return list[0];
}

function renderPrimary(f, radarMeta){
  if (!f) return;

  const cs = (f.callsign || "—").trim() || "—";
  const route = f.route || f.originDest || "—";
  const model = f.aircraftType || f.model || f.typeName || "—";

  $("callsign").textContent = cs;
  $("route").textContent = route;
  $("model").textContent = model;
  $("icao24").textContent = (f.icao24 || "—").toLowerCase();

  // Airline display logic:
  // Don't ever use OpenSky "country" (often just "United States") as the "Airline".
  const inferredAirline = f.airlineName || f.airlineGuess || guessAirline(f.callsign);
  const countryFallback = (f.country && f.country !== "United States") ? f.country : "—";
  $("airline").textContent = inferredAirline || countryFallback;

  // Airline logo (stored as static assets in Pages)
  try {
    if (f.airlineIcao) setLogo(f.airlineIcao);
    else if (f.airlineIata) setLogo(f.airlineIata);
    else setLogo(guessAirline(f.callsign));
  } catch (e) {
    setLogo("");
  }

  $("alt").textContent = fmtAlt(f.altitudeM);
  $("spd").textContent = fmtSpd(f.velocityMs);
  $("dist").textContent = fmtDist(f.distanceM);
  $("dir").textContent = fmtDir(f.trackDeg);

  $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;

  // Requested: remove UI version and call API version 1.1
  $("debugLine").textContent = `API 1.1`;
}

function renderList(list){
  const el = $("list");
  el.innerHTML = "";
  list.forEach((f)=>{
    const row = document.createElement("div");
    row.className = "row";
    const cs = (f.callsign || "—").trim() || "—";
    const dist = fmtDist(f.distanceM);
    const alt = fmtAlt(f.altitudeM);
    const spd = fmtSpd(f.velocityMs);
    row.innerHTML = `
      <div class="left">
        <div class="cs">${cs}</div>
        <div class="sub">${dist} • ${alt} • ${spd}</div>
      </div>
      <div class="badge">${(f.icao24||"").toLowerCase()}</div>
    `;
    row.addEventListener("click", ()=>{
      selectedKey = `${f.icao24}|${(f.callsign||"").trim()}`;
    });
    el.appendChild(row);
  });
}

async function fetchJSON(url, timeoutMs){
  const ac = new AbortController();
  const t = setTimeout(()=>ac.abort(), timeoutMs || 9000);
  try{
    const r = await fetch(url, { signal: ac.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function setStatus(text){
  $("statusText").textContent = text;
}

function setErr(msg){
  const box = $("errBox");
  if (!msg) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.classList.remove("hidden");
  box.textContent = msg;
}

let tier = "A";

function setupTier(){
  const seg = $("tierSegment");
  if (!seg) return;
  seg.addEventListener("click", (e)=>{
    const btn = e.target.closest("button[data-tier]");
    if (!btn) return;
    tier = btn.dataset.tier;
    seg.querySelectorAll("button").forEach(b=>b.classList.toggle("active", b === btn));
  });
}

// NOTE: This UI version hits /opensky/states on the Worker.
async function tick(){
  try{
    setErr("");
    setStatus("Radar…");

    const base = API_ORIGIN || getApiBase();
    API_ORIGIN = base;

    const bb = {}; // Worker will use IP-based location or defaults if bb not provided.
    const url = new URL("/opensky/states", base);
    Object.entries(bb).forEach(([k,v])=>url.searchParams.set(k,v));

    const data = await fetchJSON(url.toString(), 9000);
    const states = Array.isArray(data?.states) ? data.states : [];
    const flights = Array.isArray(data?.flights) ? data.flights : [];

    // Prefer the worker's "flights" array if present, fallback to states mapping if not.
    const list = flights.length ? flights : states;

    const radarMeta = {
      count: Number.isFinite(data?.count) ? data.count : list.length,
      showing: Math.min(list.length, 5),
      apiVersion: data?.apiVersion
    };

    const primary = pickBestFlight(list);
    if (primary) renderPrimary(primary, radarMeta);

    renderList(list.slice(0,5));
    setStatus("Live");
  } catch(err){
    setStatus("Error");
    // Turn iOS Safari's opaque message into a useful one when possible
    const msg = (err && err.message) ? err.message : String(err);
    setErr(msg);
  }
}

function boot(){
  setupTier();
  tick();
  setInterval(tick, POLL_MS);
}

boot();