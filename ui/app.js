// FlightWall UI (v170)
// Pages hosts UI, Worker hosts API
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v180";
const POLL_MS = 3500;

// Persist enrichments across refreshes
const enrichCache = new Map();

const $ = (id) => document.getElementById(id);
const errBox = $("errBox");

function showErr(msg){
  const m = String(msg||"");
  if (/AbortError|aborted/i.test(m)) return;
  try {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
  } catch {}
}

window.addEventListener("error", e => showErr("JS error: " + e.message));
window.addEventListener("unhandledrejection", e => showErr("Promise rejection: " + (e.reason?.message || e.reason)));

function nm(s){ return (s ?? "").toString().trim(); }

// ------------------ Math / Formatters ------------------

function haversineMi(lat1, lon1, lat2, lon2){
  const R = 3958.7613;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function headingToText(deg){
  if (!Number.isFinite(deg)) return "—";
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return `${dirs[idx]} (${Math.round(deg)}°)`;
}

function fmtAlt(m){
  if (!Number.isFinite(m)) return "—";
  return Math.round(m * 3.28084).toLocaleString() + " ft";
}

function fmtSpd(ms){
  if (!Number.isFinite(ms)) return "—";
  return Math.round(ms * 2.236936292) + " mph";
}

function fmtMi(mi){
  if (!Number.isFinite(mi)) return "—";
  return mi.toFixed(mi < 10 ? 1 : 0) + " mi";
}

// ------------------ Airline / Logos ------------------

function airlineKeyFromCallsign(cs){
  const m = nm(cs).toUpperCase().match(/^[A-Z]{3}/);
  return m ? m[0] : null;
}

function logoUrlForKey(key){
  const file = key ? `${key}.svg` : "_GENERIC.svg";
  return `/assets/logos/${file}?v=${UI_VERSION}`;
}

function logoUrlForFlight(f){
  const key =
    f.airlineIcao ||
    f.operatorIcao ||
    airlineKeyFromCallsign(f.callsign);
  return logoUrlForKey(key);
}

// ------------------ BBOX (CRITICAL) ------------------

function bboxAround(lat, lon){
  return {
    lamin: (lat - 0.6).toFixed(4),
    lamax: (lat + 0.6).toFixed(4),
    lomin: (lon - 0.8).toFixed(4),
    lomax: (lon + 0.8).toFixed(4),
  };
}

// ------------------ Fetch ------------------

async function fetchJSON(url, timeoutMs = 8000){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

// ------------------ UI Rendering ------------------

function renderPrimary(f, radarMeta){
  $("callsign").textContent = f.callsign || "—";
  $("icao24").textContent = f.icao24 || "—";
  $("airline").textContent = f.airlineName || "—";
  $("route").textContent = f.routeText || "—";
  $("model").textContent = f.modelText || "—";

  $("alt").textContent = fmtAlt(f.baroAlt);
  $("spd").textContent = fmtSpd(f.velocity);
  $("dist").textContent = fmtMi(f.distanceMi);
  $("dir").textContent = headingToText(f.trueTrack);

  const img = $("airlineLogo");
  if (img) {
    img.src = logoUrlForFlight(f);
    img.classList.remove("hidden");
  }

  $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;
  $("debugLine").textContent = `UI ${UI_VERSION} • API ${radarMeta.apiVersion || "?"}`;
}

/* 🔴 ONLY CHANGED FUNCTION */
function renderList(list){
  const el = $("list");
  el.innerHTML = "";
  list.forEach(f => {
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

// ------------------ MAIN ------------------

async function main(){
  $("statusText").textContent = "Locating…";

  const pos = await new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000
    })
  );

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const bb = bboxAround(lat, lon);

  $("statusText").textContent = "Radar…";

  async function tick(){
    try {
      const url = new URL(`${API_BASE}/opensky/states`);
      Object.entries(bb).forEach(([k,v]) => url.searchParams.set(k, v));

      const data = await fetchJSON(url.toString());
      const states = Array.isArray(data?.states) ? data.states : [];

      if (!states.length) return;

      const flights = states.map(s => {
        const lat2 = s[6];
        const lon2 = s[5];
        return {
          icao24: nm(s[0]),
          callsign: nm(s[1]),
          baroAlt: s[7],
          velocity: s[9],
          trueTrack: s[10],
          distanceMi: haversineMi(lat, lon, lat2, lon2)
        };
      }).sort((a,b) => a.distanceMi - b.distanceMi);

      const primary = flights[0];
      renderPrimary(primary, { count: flights.length, showing: 5 });
      renderList(flights.slice(0,5));

      $("statusText").textContent = "Live";
    } catch (e){
      showErr(e.message || e);
      $("statusText").textContent = "Radar error";
    }
  }

  await tick();
  setInterval(tick, POLL_MS);
}

main();
