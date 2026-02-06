// FlightWall UI (v180)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v180";
const POLL_MS = 3500;

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
  return Math.round(m * 3.28084).toLocaleString() + " ft";
}
function fmtSpd(ms) {
  if (!Number.isFinite(ms)) return "—";
  return Math.round(ms * 2.236936) + " mph";
}
function fmtMi(mi) {
  if (!Number.isFinite(mi)) return "—";
  return mi.toFixed(mi < 10 ? 1 : 0) + " mi";
}

function airlineKeyFromCallsign(callsign){
  const cs = (callsign || "").toUpperCase().trim();
  const m = cs.match(/^([A-Z]{3})/);
  return m ? m[1] : null;
}

function logoUrlForKey(key){
  const file = key ? `${key}.svg` : `_GENERIC.svg`;
  return `/assets/logos/${file}?v=${encodeURIComponent(UI_VERSION)}`;
}

function logoUrlForFlight(f){
  const key = (f?.airlineIcao || f?.operatorIcao || airlineKeyFromCallsign(f?.callsign || ""))?.toUpperCase?.();
  return logoUrlForKey(key);
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

function guessAirline(callsign){
  const map = { AAL:'American', ASA:'Alaska', DAL:'Delta', FFT:'Frontier', JBU:'JetBlue', NKS:'Spirit', SKW:'SkyWest', SWA:'Southwest', UAL:'United', AAY:'Allegiant', ENY:'Envoy', JIA:'PSA', RPA:'Republic', GJS:'GoJet', EDV:'Endeavor' };
  return map[airlineKeyFromCallsign(callsign)] || null;
}

function renderPrimary(f, radarMeta){
  $("callsign").textContent = f.callsign || "—";
  $("icao24").textContent = f.icao24 || "—";
  $("airline").textContent = f.airlineName || guessAirline(f.callsign) || f.country || "—";
  $("route").textContent = f.routeText || "—";
  $("model").textContent = f.modelText || "—";

  $("alt").textContent = fmtAlt(f.baroAlt);
  $("spd").textContent = fmtSpd(f.velocity);
  $("dist").textContent = fmtMi(f.distanceMi);
  $("dir").textContent = headingToText(f.trueTrack);

  $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;
  $("debugLine").textContent = `UI ${UI_VERSION} • API ${radarMeta.apiVersion || "?"}`;

  const logo = $("airlineLogo");
  if (logo) {
    logo.src = logoUrlForFlight(f);
    logo.alt = f.callsign || "Airline logo";
    logo.classList.remove("hidden");
  }
}

function renderList(list){
  const el = $("list");
  el.innerHTML = "";
  list.forEach(f => {
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = `
      <div class="left">
        <div class="cs">${f.callsign || "—"} <span class="hex">${f.icao24 || ""}</span></div>
        <div class="sub">${fmtMi(f.distanceMi)} • ${fmtAlt(f.baroAlt)} • ${fmtSpd(f.velocity)}</div>
      </div>
    `;
    el.appendChild(div);
  });
}

// Tier logic
const TIER_A_PREFIXES = ["AAL","DAL","UAL","SWA","ASA","FFT","NKS","JBU","AAY"];
const TIER_B_EXTRA_PREFIXES = ["SKW","ENY","EDV","JIA","RPA","GJS","UPS","FDX"];
const TIER_ALL_PREFIXES = [...new Set([...TIER_A_PREFIXES, ...TIER_B_EXTRA_PREFIXES])];

function groupForFlight(cs){
  const prefix = airlineKeyFromCallsign(cs);
  if (!prefix) return "B";
  return TIER_ALL_PREFIXES.includes(prefix) ? "A" : "B";
}

async function fetchJSON(url, timeoutMs = 8000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function main(){
  $("statusText").textContent = "Locating…";

  let tier = localStorage.getItem("fw_tier") || "A";

  const btns = document.querySelectorAll("#tierSegment button[data-tier]");
  btns.forEach(btn => {
    btn.addEventListener("click", () => {
      tier = btn.getAttribute("data-tier");
      localStorage.setItem("fw_tier", tier);
      btns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      tick();
    });
  });

  const pos = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000
    });
  });

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const bbox = bboxAround(lat, lon);

  $("statusText").textContent = "Radar…";

  let apiVersion = "?";
  try {
    const h = await fetchJSON(`${API_BASE}/health`, 6000);
    apiVersion = h?.version || "?";
  } catch {}

  async function tick(){
    try {
      const url = new URL(`${API_BASE}/opensky/states`);
      Object.entries(bbox).forEach(([k,v]) => url.searchParams.set(k,v));
      const data = await fetchJSON(url.toString(), 8000);

      const flights = (data.states || []).map(s => {
        const f = {
          icao24: nm(s[0]).toLowerCase(),
          callsign: nm(s[1]),
          country: nm(s[2]),
          lon: s[5], lat: s[6],
          baroAlt: s[7], velocity: s[9], trueTrack: s[10],
        };
        f.distanceMi = (f.lat && f.lon) ? haversineMi(lat, lon, f.lat, f.lon) : Infinity;
        return f;
      }).filter(f => Number.isFinite(f.distanceMi));

      const shown = flights.filter(f => groupForFlight(f.callsign) === tier);
      const primary = shown[0] || flights[0];
      const top5 = shown.slice(0,5);

      if (!top5.length) {
        $("statusText").textContent = "No flights";
        return;
      }

      $("statusText").textContent = "Live";

      renderPrimary(primary, {
        count: flights.length,
        showing: top5.length,
        apiVersion
      });
      renderList(top5);
    } catch(e) {
      showErr(e.message || e);
      $("statusText").textContent = "Radar error";
    }
  }

  tick();
  setInterval(tick, POLL_MS);
}

window.addEventListener("load", main);
