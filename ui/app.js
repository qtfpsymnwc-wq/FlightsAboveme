// FlightWall UI (v170)
// Option A: Pages hosts this UI, Worker hosts API.
// Set API_BASE to your Worker domain. (No trailing slash)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v180";
const POLL_MS = 3500;

// Persist Aerodatabox + aircraft enrichments across refreshes.
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

function fmtMi(mi) {
  if (!Number.isFinite(mi)) return "—";
  return mi.toFixed(mi < 10 ? 1 : 0) + " mi";
}

function guessAirline(callsign){
  const c=(callsign||'').trim().toUpperCase();
  const p3=c.slice(0,3);
  const map={AAL:'American',ASA:'Alaska',DAL:'Delta',FFT:'Frontier',JBU:'JetBlue',NKS:'Spirit',SKW:'SkyWest',SWA:'Southwest',UAL:'United',AAY:'Allegiant'};
  return map[p3]||null;
}

function airlineKeyFromCallsign(callsign){
  const cs=(callsign||'').trim().toUpperCase();
  const m = cs.match(/^([A-Z]{3})/);
  return m ? m[1] : null;
}

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

function renderPrimary(f, radarMeta){
  $("callsign").textContent = f.callsign || "—";
  $("icao24").textContent = f.icao24 || "—";

  const inferredAirline = f.airlineName || f.airlineGuess || guessAirline(f.callsign);
  $("airline").textContent = inferredAirline || "—";

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
    }
  } catch {}

  $("alt").textContent = fmtAlt(f.baroAlt);
  $("spd").textContent = fmtSpd(f.velocity);
  $("dist").textContent = fmtMi(f.distanceMi);
  $("dir").textContent = headingToText(f.trueTrack);

  $("route").textContent = f.routeText || "—";
  $("model").textContent = f.modelText || "—";

  $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;
  $("debugLine").textContent = `UI ${UI_VERSION} • API ${radarMeta.apiVersion || "?"}`;
}

/* ============================================================
   🔴 THIS IS THE ONLY FUNCTION THAT CHANGED
   Old row-based list → New card-based list
   ============================================================ */
function renderList(list){
  const el = $("list");
  el.innerHTML = "";

  list.forEach((f)=>{
    const card = document.createElement("div");
    card.className = "flightCard";
    card.innerHTML = `
      <div class="flightTop">
        <strong>${f.callsign || "—"}</strong>
        <span class="icao24Small">${f.icao24 || ""}</span>
      </div>
      <div class="flightDetails">
        ${fmtMi(f.distanceMi)} • ${fmtAlt(f.baroAlt)} • ${fmtSpd(f.velocity)}
      </div>
    `;
    el.appendChild(card);
  });
}
/* =================== END CHANGE =================== */

function normalizeCallsign(cs){
  return nm(cs).replace(/\s+/g,"").toUpperCase();
}

async function fetchJSON(url, timeoutMs=8000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,160)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function main(){
  $("statusText").textContent = "Locating…";

  const pos = await new Promise((resolve, reject)=>{
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy:true });
  });

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;

  $("statusText").textContent = "Radar…";

  async function tick(){
    try {
      const data = await fetchJSON(`${API_BASE}/opensky/states`);
      const states = data?.states || [];

      const flights = states.map((s)=>{
        const lat2 = s[6], lon2 = s[5];
        const distanceMi = haversineMi(lat, lon, lat2, lon2);
        return {
          icao24: s[0],
          callsign: nm(s[1]),
          baroAlt: s[7],
          velocity: s[9],
          trueTrack: s[10],
          distanceMi
        };
      }).sort((a,b)=>a.distanceMi-b.distanceMi);

      if (!flights.length) return;

      const primary = flights[0];
      renderPrimary(primary, { count: flights.length, showing: 5 });
      renderList(flights.slice(0,5));
      $("statusText").textContent = "Live";
    } catch (e){
      showErr(e.message || e);
    }
  }

  await tick();
  setInterval(tick, POLL_MS);
}

main();
