// FlightWall Ultimate — v5
// Fixes: "Unavailable / Unknown" by restoring proxy ICAO24 fallback + inference UI
// Adds: Regional carriers (Envoy, SkyWest, PSA, Republic, etc.) + wider range for Fayetteville/XNA

let HOME_LAT = null;
let HOME_LON = null;

const RANGE = 2.0;        // wider box for NWA
const OVERHEAD_MI = 0.75; // ~1.2 km

let flightsCache = [];
let index = 0;

const PROXY = "https://flightsabove.t2hkmhgbwz.workers.dev/";

const AIRLINES = {
  // Mainline
  AAL: { name: "American", logo: "https://content.airhex.com/content/logos/airlines_AAL_200_200_s.png" },
  DAL: { name: "Delta", logo: "https://content.airhex.com/content/logos/airlines_DAL_200_200_s.png" },
  UAL: { name: "United", logo: "https://content.airhex.com/content/logos/airlines_UAL_200_200_s.png" },
  SWA: { name: "Southwest", logo: "https://content.airhex.com/content/logos/airlines_SWA_200_200_s.png" },
  JBU: { name: "JetBlue", logo: "https://content.airhex.com/content/logos/airlines_JBU_200_200_s.png" },
  FFT: { name: "Frontier", logo: "https://content.airhex.com/content/logos/airlines_FFT_200_200_s.png" },
  ASA: { name: "Alaska", logo: "https://content.airhex.com/content/logos/airlines_ASA_200_200_s.png" },

  // Regionals
  ENY: { name: "Envoy Air", logo: "https://content.airhex.com/content/logos/airlines_ENY_200_200_s.png" },
  JIA: { name: "PSA Airlines", logo: "https://content.airhex.com/content/logos/airlines_JIA_200_200_s.png" },
  PDT: { name: "Piedmont Airlines", logo: "https://content.airhex.com/content/logos/airlines_PDT_200_200_s.png" },
  RPA: { name: "Republic Airways", logo: "https://content.airhex.com/content/logos/airlines_RPA_200_200_s.png" },
  SKW: { name: "SkyWest Airlines", logo: "https://content.airhex.com/content/logos/airlines_SKW_200_200_s.png" },
  UCA: { name: "CommuteAir", logo: "https://content.airhex.com/content/logos/airlines_UCA_200_200_s.png" },
  GJS: { name: "GoJet Airlines", logo: "https://content.airhex.com/content/logos/airlines_GJS_200_200_s.png" },
  EDV: { name: "Endeavor Air", logo: "https://content.airhex.com/content/logos/airlines_EDV_200_200_s.png" },
  ASH: { name: "Mesa Airlines", logo: "https://content.airhex.com/content/logos/airlines_ASH_200_200_s.png" },
  AWI: { name: "Air Wisconsin", logo: "https://content.airhex.com/content/logos/airlines_AWI_200_200_s.png" },
};

// Hubs used ONLY for inference (when the live route is missing)
const HUBS = {
  AAL: [
    { iata: "DFW", lat: 32.897, lon: -97.040 }, { iata: "CLT", lat: 35.214, lon: -80.943 },
    { iata: "ORD", lat: 41.974, lon: -87.907 }, { iata: "PHL", lat: 39.874, lon: -75.243 },
    { iata: "MIA", lat: 25.795, lon: -80.287 }, { iata: "PHX", lat: 33.435, lon: -112.005 },
  ],
  DAL: [
    { iata: "ATL", lat: 33.640, lon: -84.427 }, { iata: "DTW", lat: 42.216, lon: -83.355 },
    { iata: "MSP", lat: 44.884, lon: -93.222 }, { iata: "SLC", lat: 40.789, lon: -111.978 },
  ],
  UAL: [
    { iata: "ORD", lat: 41.974, lon: -87.907 }, { iata: "IAH", lat: 29.984, lon: -95.341 },
    { iata: "DEN", lat: 39.856, lon: -104.673 }, { iata: "SFO", lat: 37.621, lon: -122.379 },
  ],
  SWA: [
    { iata: "DAL", lat: 32.847, lon: -96.852 }, { iata: "HOU", lat: 29.645, lon: -95.278 },
    { iata: "DEN", lat: 39.856, lon: -104.673 }, { iata: "LAS", lat: 36.080, lon: -115.152 },
    { iata: "PHX", lat: 33.435, lon: -112.005 }, { iata: "MDW", lat: 41.786, lon: -87.752 },
  ],
};

function cleanCallsign(cs) { return (cs || "").replace(/\s+/g, "").toUpperCase(); }
function airlinePrefix(cs) { return cleanCallsign(cs).slice(0,3); }

function detectAirline(callsign) {
  const cs = cleanCallsign(callsign);
  return AIRLINES[cs.slice(0,3)] || null;
}

function toRad(x) { return x * Math.PI / 180; }
function toDeg(x) { return x * 180 / Math.PI; }

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
  return Math.round((toDeg(Math.atan2(y,x)) + 360) % 360);
}

function angDiff(a,b) {
  const d = Math.abs(a-b) % 360;
  return d > 180 ? 360-d : d;
}

// Keep "commercial only" but less strict so regionals near XNA show up
function isCommercial(osState) {
  const speedKt = (osState[9] || 0) * 1.94;
  const altFt = (osState[7] || 0) * 3.28;
  const callsign = (osState[1] || "").trim();
  return speedKt > 170 && altFt > 5000 && !!detectAirline(callsign);
}

// /adsb/<CALLSIGN>?icao24=<ICAO24>
async function lookupFlight(callsign, icao24) {
  const cs = cleanCallsign(callsign);
  const icao = (icao24 || "").trim().toUpperCase();
  const q = icao ? `?icao24=${encodeURIComponent(icao)}` : "";
  try {
    const res = await fetch(PROXY + "adsb/" + encodeURIComponent(cs) + q);
    const data = await res.json();
    if (data && typeof data === "object") return data;
  } catch {}
  return { route: "Unavailable", model: "Unknown", callsign: cs };
}

function inferRoute(flight) {
  const pref = airlinePrefix(flight.callsign);
  const parent = (pref === "ENY" || pref === "JIA" || pref === "PDT") ? "AAL"
               : (pref === "EDV") ? "DAL"
               : (pref === "SKW" || pref === "UCA" || pref === "GJS") ? "UAL"
               : pref;

  const hubs = HUBS[parent] || [];
  if (!hubs.length || HOME_LAT === null || HOME_LON === null) {
    return { route: "EN ROUTE", inferred: true, confidence: "low" };
  }

  const dest = hubs.map(h => {
    const brgTo = bearing(HOME_LAT, HOME_LON, h.lat, h.lon);
    return {...h, dAng: angDiff(flight.brg, brgTo), dKm: distance(HOME_LAT, HOME_LON, h.lat, h.lon)};
  }).sort((a,b) => (a.dAng-b.dAng) || (a.dKm-b.dKm))[0];

  const back = (flight.brg + 180) % 360;
  const orig = hubs.map(h => {
    const brgTo = bearing(HOME_LAT, HOME_LON, h.lat, h.lon);
    return {...h, dAng: angDiff(back, brgTo), dKm: distance(HOME_LAT, HOME_LON, h.lat, h.lon)};
  }).sort((a,b) => (a.dAng-b.dAng) || (a.dKm-b.dKm))[0];

  if (!dest || !orig || dest.iata === orig.iata) {
    return { route: "EN ROUTE", inferred: true, confidence: "low" };
  }

  const confidence = (dest.dAng < 25 && orig.dAng < 25) ? "high" : (dest.dAng < 45 ? "medium" : "low");
  return { route: `${orig.iata} → ${dest.iata}`, inferred: true, confidence };
}

function fallbackModel(flight) {
  const pref = airlinePrefix(flight.callsign);
  if (pref === "SWA") return "B737 (family)";
  if (pref === "ENY" || pref === "JIA" || pref === "PDT") return "Regional jet";
  if (pref === "SKW" || pref === "EDV" || pref === "ASH" || pref === "AWI" || pref === "RPA") return "Regional jet";
  return "Airliner";
}

async function detectLocation() {
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(pos => {
      HOME_LAT = pos.coords.latitude;
      HOME_LON = pos.coords.longitude;
      document.getElementById("fw-location").innerText = `Location: ${HOME_LAT.toFixed(3)}, ${HOME_LON.toFixed(3)}`;
      resolve();
    }, () => {
      HOME_LAT = 36.19; HOME_LON = -94.13;
      document.getElementById("fw-location").innerText = "Location: Default (Arkansas)";
      resolve();
    }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 8000 });
  });
}

async function loadFlights() {
  if (HOME_LAT === null || HOME_LON === null) return;
  const status = document.getElementById("fw-status");
  try {
    const url = `https://opensky-network.org/api/states/all?lamin=${HOME_LAT-RANGE}&lomin=${HOME_LON-RANGE}&lamax=${HOME_LAT+RANGE}&lomax=${HOME_LON+RANGE}`;
    const res = await fetch(url);
    const data = await res.json();

    flightsCache = (data.states || [])
      .filter(isCommercial)
      .map(f => {
        const icao24 = (f[0] || "").toUpperCase();
        const callsign = cleanCallsign(f[1] || "UNKNOWN");
        const lat = f[6], lon = f[5];
        return {
          icao24,
          callsign,
          alt: Math.round((f[7] || 0) * 3.28),
          speed: Math.round(((f[9] || 0) * 2.23694)),
          dist: distance(HOME_LAT, HOME_LON, lat, lon) * 0.621371,
          brg: bearing(HOME_LAT, HOME_LON, lat, lon),
          airline: detectAirline(callsign),
        };
      })
      .filter(x => Number.isFinite(x.dist))
      .sort((a,b) => a.dist - b.dist)
      .slice(0, 16);

    status.innerText = `LIVE: ${flightsCache.length} commercial aircraft`;
  } catch {
    status.innerText = "Radar feed error.";
  }
}

async function renderFlight() {
  if (!flightsCache.length) return;

  const flight = flightsCache[index % flightsCache.length];
  index++;

  const live = await lookupFlight(flight.callsign, flight.icao24);

  let routeText = live.route || "Unavailable";
  let modelText = live.model || "Unknown";
  let badgeHtml = "";

  const missingRoute = (!routeText || routeText === "Unavailable");
  const missingModel = (!modelText || modelText === "Unknown");

  if (missingRoute) {
    const inf = inferRoute(flight);
    routeText = inf.route;
    badgeHtml = `<span class="badge inferred">INFERRED (${inf.confidence})</span>`;
  }

  if (missingModel) {
    modelText = fallbackModel(flight);
    if (!badgeHtml) badgeHtml = `<span class="badge missing">LIMITED DATA</span>`;
  }

  const overhead = flight.dist < OVERHEAD_MI && flight.alt > 2000;

  document.getElementById("fw-current").innerHTML = `
    <div class="flight-header ${overhead ? "overhead" : ""}">
      ${flight.airline?.logo ? `<img class="logo" src="${flight.airline.logo}" alt="" onerror="this.remove()">` : ""}
      ${flight.callsign}
      ${badgeHtml}
    </div>
    <div class="flight-route">${routeText} • ${modelText}</div>
    <div class="kv"><span class="muted">AIRLINE</span><span>${flight.airline?.name || "—"}</span></div>
    <div class="flight-stats">
      <div class="stat"><span>ALT</span><span>${flight.alt.toLocaleString()} ft</span></div>
      <div class="stat"><span>SPD</span><span>${flight.speed} mph</span></div>
      <div class="stat"><span>DIST</span><span>${flight.dist.toFixed(1)} mi</span></div>
      <div class="stat"><span>BRG</span><span>${flight.brg}°</span></div>
    </div>
    ${overhead ? "<div style='margin-top:8px;'>⚠ OVERHEAD AIRCRAFT</div>" : ""}
  `;

  const items = flightsCache
    .slice(1, 11)
    .map(f => `<div class="queue-item"><span>${f.callsign}</span><span>${f.dist.toFixed(1)} mi</span></div>`)
    .join("");

  // Duplicate items so the ticker can loop smoothly
  document.getElementById("fw-queue").innerHTML =
    `<div class="ticker"><div class="ticker-track">${items}${items}</div></div>`;
}

async function init() {
  await detectLocation();
  await loadFlights();
  await renderFlight();
  setInterval(loadFlights, 10000);
  setInterval(renderFlight, 5500);
}

init();
