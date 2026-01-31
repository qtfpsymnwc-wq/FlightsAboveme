// FlightWall Ultimate — v5
// Fixes: "Unavailable / Unknown" by restoring proxy ICAO24 fallback + inference UI
// Adds: Regional carriers (Envoy, SkyWest, PSA, Republic, etc.) + wider range for Fayetteville/XNA

let HOME_LAT = null;
let HOME_LON = null;

let SHOW_ALL = false; // toggle: commercial-only vs all flights
let RANGE_MI = 120;    // adjustable range in miles


const RANGE = 2.0;        // wider box for NWA
const OVERHEAD_MI = 0.75; // ~1.2 km

let flightsCache = [];
let index = 0;



let tickerRAF = null;

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function startTicker() {
  // JS ticker: works even when CSS animations are disabled by device settings/bugs.
  if (prefersReducedMotion()) return;

  const track = document.querySelector(".ticker-track");
  if (!track) return;

  // Measure half width (we duplicate items so half = one set)
  const half = track.scrollWidth / 2;
  if (!half || !isFinite(half)) return;

  let x = 0;
  const pxPerSec = (window.innerWidth < 768) ? 70 : 55; // phone a bit faster
  let last = performance.now();

  const step = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    x -= pxPerSec * dt;
    if (Math.abs(x) >= half) x = 0;
    track.style.transform = `translateX(${x}px)`;
    tickerRAF = requestAnimationFrame(step);
  };

  if (tickerRAF) cancelAnimationFrame(tickerRAF);
  tickerRAF = requestAnimationFrame(step);
}

const PROXY = "https://flightsabove.t2hkmhgbwz.workers.dev/";

window.addEventListener('error', (e) => {
  const s = document.getElementById("fw-status");
  if (s) s.innerText = "JS error: " + (e.message || "unknown");
});
window.addEventListener('unhandledrejection', (e) => {
  const s = document.getElementById("fw-status");
  if (s) s.innerText = "Promise error: " + (e.reason?.message || e.reason || "unknown");
});


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

// Airport code -> city name (expand anytime)
const AIRPORTS = {
  /* =====================
     NORTHWEST ARKANSAS
  ===================== */
  XNA: "Northwest Arkansas",


  /* =====================
     LOCAL MUNICIPAL (NW AR / NE OK / SW MO)
  ===================== */
  FYV: "Fayetteville (Drake Field)",
  VBT: "Bentonville (Thaden Field)",
  ASG: "Springdale",
  ROG: "Rogers",
  SLG: "Siloam Springs",
  FSM: "Fort Smith",
  HRO: "Harrison",
  GMJ: "Grove",
  MIO: "Miami (OK)",
  BVO: "Bartlesville",
  RVS: "Tulsa (Riverside)",
  JLN: "Joplin",
  BKG: "Branson",
  HFJ: "Monett",
  SGF: "Springfield (MO)",

  // ICAO / FAA (K- prefix) equivalents for local fields
  KFYV: "Fayetteville (Drake Field)",
  KVBT: "Bentonville (Thaden Field)",
  KASG: "Springdale",
  KROG: "Rogers",
  KSLG: "Siloam Springs",
  KFSM: "Fort Smith",
  KHRO: "Harrison",
  KGMJ: "Grove",
  KMIO: "Miami (OK)",
  KBVO: "Bartlesville",
  KRVS: "Tulsa (Riverside)",
  KJLN: "Joplin",
  KBBG: "Branson",
  KHFJ: "Monett",
  KSGF: "Springfield (MO)",
  /* =====================
     TEXAS / CENTRAL HUBS
  ===================== */
  DFW: "Dallas–Fort Worth",
  DAL: "Dallas Love Field",

  // Some major ICAO codes (if a feed returns ICAO instead of IATA)
  KDFW: "Dallas–Fort Worth",
  KDAL: "Dallas Love Field",
  KDEN: "Denver",
  KORD: "Chicago O'Hare",
  KATL: "Atlanta",
  KCLT: "Charlotte",
  KLAX: "Los Angeles",
  KSFO: "San Francisco",
  KSJC: "San Jose",
  KMCO: "Orlando",
  KTPA: "Tampa",
  KMIA: "Miami",
  KFLL: "Fort Lauderdale",
  IAH: "Houston",
  HOU: "Houston Hobby",
  AUS: "Austin",
  SAT: "San Antonio",

  /* =====================
     MIDWEST / CENTRAL
  ===================== */
  DEN: "Denver",
  ORD: "Chicago O'Hare",
  MDW: "Chicago Midway",
  STL: "St. Louis",
  MCI: "Kansas City",
  MSP: "Minneapolis–St. Paul",
  DTW: "Detroit",
  BNA: "Nashville",
  MEM: "Memphis",
  OMA: "Omaha",
  TUL: "Tulsa",
  OKC: "Oklahoma City",

  /* =====================
     NORTHEAST / EAST COAST
  ===================== */
  JFK: "New York JFK",
  LGA: "New York LaGuardia",
  EWR: "Newark",
  BOS: "Boston",
  PHL: "Philadelphia",
  DCA: "Washington National",
  IAD: "Washington Dulles",
  BWI: "Baltimore",

  /* =====================
     SOUTHEAST
  ===================== */
  ATL: "Atlanta",
  CLT: "Charlotte",
  RDU: "Raleigh–Durham",
  CHS: "Charleston",
  SAV: "Savannah",

  /* =====================
     FLORIDA / SPRING BREAK
  ===================== */
  MCO: "Orlando",
  TPA: "Tampa",
  FLL: "Fort Lauderdale",
  MIA: "Miami",
  PBI: "Palm Beach",
  RSW: "Fort Myers",
  ECP: "Panama City Beach",
  VPS: "Destin–Fort Walton Beach",
  PNS: "Pensacola",
  SRQ: "Sarasota",
  JAX: "Jacksonville",

  /* =====================
     GULF / LEISURE (nearby)
  ===================== */
  MOB: "Mobile",
  GPT: "Gulfport–Biloxi",
  MSY: "New Orleans",

  /* =====================
     CALIFORNIA / WEST COAST
  ===================== */
  LAX: "Los Angeles",
  SFO: "San Francisco",
  SJC: "San Jose",
  OAK: "Oakland",
  SAN: "San Diego",
  BUR: "Burbank",
  LGB: "Long Beach",
  SNA: "Orange County",
  SMF: "Sacramento",
  SEA: "Seattle",
  PDX: "Portland",
  PHX: "Phoenix",
  LAS: "Las Vegas",

  /* =====================
     CANADA
  ===================== */
  YYZ: "Toronto",
  YVR: "Vancouver",
  YUL: "Montreal",
  YYC: "Calgary",

  /* =====================
     MEXICO (VERY COMMON)
  ===================== */
  CUN: "Cancún",
  SJD: "Los Cabos",
  PVR: "Puerto Vallarta",
  MEX: "Mexico City",
  GDL: "Guadalajara",
  MTY: "Monterrey",
  CZM: "Cozumel",

  /* =====================
     CARIBBEAN
  ===================== */
  PUJ: "Punta Cana",
  MBJ: "Montego Bay",
  NAS: "Nassau",
  AUA: "Aruba",
  CUR: "Curaçao",
  STT: "St. Thomas",
  STX: "St. Croix",
  SJU: "San Juan",

  /* =====================
     EUROPE (OVERFLIGHTS)
  ===================== */
  LHR: "London Heathrow",
  LGW: "London Gatwick",
  CDG: "Paris Charles de Gaulle",
  AMS: "Amsterdam",
  FRA: "Frankfurt",
  MUC: "Munich",
  ZRH: "Zurich",
  VIE: "Vienna",
  MAD: "Madrid",
  BCN: "Barcelona",
  DUB: "Dublin",

  /* =====================
     ASIA / PACIFIC (OVERFLIGHTS)
  ===================== */
  NRT: "Tokyo Narita",
  HND: "Tokyo Haneda",
  ICN: "Seoul Incheon",
  PVG: "Shanghai Pudong",
  PEK: "Beijing Capital",
  HKG: "Hong Kong",
  SIN: "Singapore",
};


function formatRouteWithCities(routeText) {
  if (!routeText || typeof routeText !== "string") return routeText;

  // Match "AAA → BBB" or "KAAA → KBBB"
  const m = routeText.match(/^([A-Z]{3,4})\s*→\s*([A-Z]{3,4})$/);
  if (!m) return routeText;

  const a = m[1], b = m[2];
  const ac = AIRPORTS[a] ? `${AIRPORTS[a]} (${a})` : a;
  const bc = AIRPORTS[b] ? `${AIRPORTS[b]} (${b})` : b;
  return `${ac} → ${bc}`;
}




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


function milesToDegLat(mi){ return mi / 69.0; }
function milesToDegLon(mi, lat){
  const cos = Math.cos((lat||0) * Math.PI/180);
  return mi / (69.0 * (cos || 1));
}
function compassDir(deg){
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  const i = Math.round(((deg % 360) / 22.5)) % 16;
  return dirs[i];
}
function bearingArrow(deg){
  const arrows = ["↑","↗","→","↘","↓","↙","←","↖"];
  const i = Math.round(((deg % 360) / 45)) % 8;
  return arrows[i];
}


function deg2rad(d){ return d * Math.PI/180; }
function rad2deg(r){ return r * 180/Math.PI; }

function angularDistanceRad(lat1, lon1, lat2, lon2){
  const φ1 = deg2rad(lat1), φ2 = deg2rad(lat2);
  const Δφ = deg2rad(lat2-lat1);
  const Δλ = deg2rad(lon2-lon1);
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function initialBearingDeg(lat1, lon1, lat2, lon2){
  const φ1 = deg2rad(lat1), φ2 = deg2rad(lat2);
  const λ1 = deg2rad(lon1), λ2 = deg2rad(lon2);
  const y = Math.sin(λ2-λ1)*Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
  return (rad2deg(Math.atan2(y, x)) + 360) % 360;
}

// Cross-track distance from point P to great-circle path A->B (miles)
function crossTrackMiles(latA, lonA, latB, lonB, latP, lonP){
  const R = 3958.8; // Earth radius in miles
  const δ13 = angularDistanceRad(latA, lonA, latP, lonP);
  const θ13 = deg2rad(initialBearingDeg(latA, lonA, latP, lonP));
  const θ12 = deg2rad(initialBearingDeg(latA, lonA, latB, lonB));
  const dxt = Math.asin(Math.sin(δ13) * Math.sin(θ13 - θ12)) * R;
  return Math.abs(dxt);
}

// Along-track distance from A to closest point to P on path A->B (miles)
function alongTrackMiles(latA, lonA, latB, lonB, latP, lonP){
  const R = 3958.8;
  const δ13 = angularDistanceRad(latA, lonA, latP, lonP);
  const dxt = crossTrackMiles(latA, lonA, latB, lonB, latP, lonP) / R;
  const dat = Math.acos(Math.cos(δ13) / Math.cos(dxt)) * R;
  return dat;
}

function routeLooksPlausible(live, flight){
  const o = live?.origin, d = live?.destination;
  if (!o || !d) return true; // nothing to validate
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon) || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) return true;
  if (!Number.isFinite(flight?.lat) || !Number.isFinite(flight?.lon)) return true;

  const total = (angularDistanceRad(o.lat, o.lon, d.lat, d.lon) * 3958.8);
  if (!isFinite(total) || total < 80) return true;

  const xt = crossTrackMiles(o.lat, o.lon, d.lat, d.lon, flight.lat, flight.lon);
  const at = alongTrackMiles(o.lat, o.lon, d.lat, d.lon, flight.lat, flight.lon);

  // Must be reasonably near the corridor and between endpoints (with slack)
  const corridor = Math.max(180, Math.min(320, total * 0.18)); // 180–320 mi based on route length
  const between = at > -120 && at < total + 120;

  return xt <= corridor && between;
}

function normalizeArrow(s){
  if (!s || typeof s !== "string") return s;
  return s.replace(/â†’/g, "→");
}



function formatLiveRoute(live){
  // Prefer cities from proxy if present, else fall back to route text as-is
  const o = live?.origin;
  const d = live?.destination;
  if (o && d) {
    const oCode = o.iata || o.icao;
    const dCode = d.iata || d.icao;
    const oCity = o.city || o.name || oCode;
    const dCity = d.city || d.name || dCode;
    if (oCode && dCode) return `${oCity} (${oCode}) → ${dCity} (${dCode})`;
  }
  return normalizeArrow(live?.route) || null;
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
  const speedMph = (osState[9] || 0) * 2.23694;
  const altFt = (osState[7] || 0) * 3.28084;
  const callsign = (osState[1] || "").trim();
  return speedMph > 170 && altFt > 5000 && !!detectAirline(callsign);
}

function isAnyFlight(osState){
  const speedMph = (osState[9] || 0) * 2.23694;
  const altFt = (osState[7] || 0) * 3.28084;
  const lat = osState[6], lon = osState[5];
  const onGround = osState[8];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (onGround) return false;
  return speedMph > 60 && altFt > 1000;
}

function isIncluded(osState){
  return SHOW_ALL ? isAnyFlight(osState) : isCommercial(osState);
}

// /adsb/<CALLSIGN>?icao24=<ICAO24>
async function lookupFlight(callsign, icao24) {
  const cs = cleanCallsign(callsign);
  const icao = (icao24 || "").trim().toUpperCase();
  const q = icao ? `?icao24=${encodeURIComponent(icao)}` : "";
  try {
    const res = await fetch(PROXY + "adsb/" + encodeURIComponent(cs) + q);
    let data;
    try { data = await res.json(); }
    catch (e) {
      status.innerText = 'Radar feed error (bad OpenSky JSON)';
      document.getElementById('fw-current').innerHTML = `<div class="empty-state">${status.innerText}<div class="empty-sub">If you just updated the Worker, hard refresh (Safari cache) and confirm the Worker is deployed.</div></div>`;
      return;
    }
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
    const dLat = milesToDegLat(RANGE_MI);
    const dLon = milesToDegLon(RANGE_MI, HOME_LAT);
    const url = `${PROXY}opensky/states?lamin=${HOME_LAT-dLat}&lomin=${HOME_LON-dLon}&lamax=${HOME_LAT+dLat}&lomax=${HOME_LON+dLon}`;
    const res = await fetch(url);
    if (!res.ok) {
      status.innerText = `Radar feed error (OpenSky ${res.status})`;
      return;
    }
    let data;
    try { data = await res.json(); }
    catch (e) {
      status.innerText = 'Radar feed error (bad OpenSky JSON)';
      document.getElementById('fw-current').innerHTML = `<div class="empty-state">${status.innerText}<div class="empty-sub">If you just updated the Worker, hard refresh (Safari cache) and confirm the Worker is deployed.</div></div>`;
      return;
    }

    flightsCache = (data.states || [])
      .filter(isIncluded)
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

    status.innerText = `LIVE: ${flightsCache.length} aircraft • ${SHOW_ALL ? 'ALL' : 'COMMERCIAL'} • ${RANGE_MI} mi`;
    if (!flightsCache.length) {
      document.getElementById('fw-current').innerHTML = `<div class="empty-state">No commercial flights in range<div class="empty-sub">Try increasing RANGE or wait a minute — and check the ticker.</div></div>`;
    }
  } catch {
    status.innerText = "Radar feed error.";
  }
}

async function renderFlight() {
  if (!flightsCache.length) {
  document.getElementById('fw-current').innerHTML = `<div class="empty-state">Waiting for radar data…<div class="empty-sub">If this persists, your OpenSky proxy may not be deployed yet.</div></div>`;
  return;
}

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
    badgeHtml = "";
  }

  if (missingModel) {
    modelText = fallbackModel(flight);
  }

  // If proxy provided registration, show it lightly (helps ID the aircraft)
  if (live && live.registration && modelText && modelText !== "Airliner" && modelText !== "Regional jet") {
    modelText = `${modelText} • ${live.registration}`;
  }

  const overhead = flight.dist < OVERHEAD_MI && flight.alt > 2000;

  document.getElementById("fw-current").innerHTML = `
    <div class="flight-header ${overhead ? "overhead" : ""}">
      ${flight.airline?.logo ? `<img class="logo" src="${flight.airline.logo}" alt="" onerror="this.remove()">` : ""}
      ${flight.callsign}
      ${badgeHtml}
    </div>
    <div class="flight-route">${formatRouteWithCities(routeText)}</div>
    <div class="flight-model">${modelText}</div>
    <div class="route-source">${routeText !== "Unavailable" ? "SOURCE: ADSBDB" : ""}</div>
    <div class="kv"><span class="muted">AIRLINE</span><span>${flight.airline?.name || "—"}</span></div>
    <div class="flight-stats">
      <div class="stat"><span>ALT</span><span>${flight.alt.toLocaleString()} ft</span></div>
      <div class="stat"><span>SPD</span><span>${flight.speed} mph</span></div>
      <div class="stat"><span>DIST</span><span>${flight.dist.toFixed(1)} mi</span></div>
      <div class="stat"><span>FROM</span><span>${bearingArrow(flight.brg)} ${compassDir(flight.brg)} (${flight.brg}°)</span></div>
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

  // (re)start ticker after DOM update
  startTicker();
}


function setupControls(){
  const btn = document.getElementById("toggleMode");
  const rng = document.getElementById("rangeMiles");
  const lbl = document.getElementById("rangeLabel");

  if (rng) {
    RANGE_MI = parseInt(rng.value, 10) || RANGE_MI;
    if (lbl) lbl.textContent = `Range: ${RANGE_MI} mi`;

    let rangeTimer = null;
    rng.addEventListener("input", () => {
      RANGE_MI = parseInt(rng.value, 10) || RANGE_MI;
      if (lbl) lbl.textContent = `Range: ${RANGE_MI} mi`;

      // Debounced refresh while scrubbing
      if (rangeTimer) clearTimeout(rangeTimer);
      rangeTimer = setTimeout(async () => {
        await loadFlights();
        await renderFlight();
      }, 350);
    });
  }

  if (btn) {
    const paint = () => {
      btn.textContent = SHOW_ALL ? "All Flights" : "Commercial";
      btn.classList.toggle("all", SHOW_ALL);
    };
    paint();

    btn.addEventListener("click", async () => {
      SHOW_ALL = !SHOW_ALL;
      paint();
      await loadFlights();
      await renderFlight();
    });
  }
}


async function init() {
  const status = document.getElementById('fw-status');
  try {
    if (status) status.innerText = 'Detecting location…';

  await detectLocation();
  setupControls();
  await loadFlights();
  await renderFlight();
  setInterval(loadFlights, 10000);
  setInterval(renderFlight, 5500);
  } catch (e) {
    if (status) status.innerText = 'Init error: ' + (e?.message || e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const s = document.getElementById('fw-status');
  if (s) s.innerText = 'Starting…';
  init();
});
