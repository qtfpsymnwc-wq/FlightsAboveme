let HOME_LAT = null;
let HOME_LON = null;
const RANGE = 0.6;
let flightsCache = [];
let index = 0;

// 👉 CHANGE THIS if you deploy your proxy somewhere else
const PROXY = "http://localhost:8787/";

const AIRLINES = {
  AAL: { name: "American", logo: "https://content.airhex.com/content/logos/airlines_AAL_200_200_s.png" },
  DAL: { name: "Delta", logo: "https://content.airhex.com/content/logos/airlines_DAL_200_200_s.png" },
  UAL: { name: "United", logo: "https://content.airhex.com/content/logos/airlines_UAL_200_200_s.png" },
  SWA: { name: "Southwest", logo: "https://content.airhex.com/content/logos/airlines_SWA_200_200_s.png" },
  JBU: { name: "JetBlue", logo: "https://content.airhex.com/content/logos/airlines_JBU_200_200_s.png" },
  FFT: { name: "Frontier", logo: "https://content.airhex.com/content/logos/airlines_FFT_200_200_s.png" },
  ASA: { name: "Alaska", logo: "https://content.airhex.com/content/logos/airlines_ASA_200_200_s.png" },
};

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI/180;
  const dLon = (lon2 - lon1) * Math.PI/180;
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) *
    Math.cos(lat2*Math.PI/180) *
    Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2-lon1)*Math.PI/180) * Math.cos(lat2*Math.PI/180);
  const x =
    Math.cos(lat1*Math.PI/180)*Math.sin(lat2*Math.PI/180) -
    Math.sin(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180) *
    Math.cos((lon2-lon1)*Math.PI/180);
  return Math.round((Math.atan2(y, x) * 180/Math.PI + 360) % 360);
}

function detectAirline(callsign) {
  const prefix = callsign.slice(0,3);
  return AIRLINES[prefix] || null;
}

function isCommercial(f) {
  const speed = (f[9] || 0) * 1.94;
  const alt = (f[7] || 0) * 3.28;
  const callsign = (f[1] || "").trim();
  return speed > 250 && alt > 10000 && detectAirline(callsign);
}

async function lookupFlight(callsign) {
  try {
    const res = await fetch(PROXY + "adsb/" + callsign);
    const data = await res.json();
    if (data && data.route) return data;
  } catch {}
  return { route: "Unavailable", model: "Unknown" };
}

async function detectLocation() {
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(pos => {
      HOME_LAT = pos.coords.latitude;
      HOME_LON = pos.coords.longitude;
      document.getElementById("fw-location").innerText =
        `Location: ${HOME_LAT.toFixed(3)}, ${HOME_LON.toFixed(3)}`;
      resolve();
    }, () => {
      HOME_LAT = 36.19;
      HOME_LON = -94.13;
      document.getElementById("fw-location").innerText = "Location: Default (Arkansas)";
      resolve();
    });
  });
}

async function loadFlights() {
  if (!HOME_LAT) return;
  const status = document.getElementById("fw-status");

  try {
    const url = `https://opensky-network.org/api/states/all?lamin=${HOME_LAT-RANGE}&lomin=${HOME_LON-RANGE}&lamax=${HOME_LAT+RANGE}&lomax=${HOME_LON+RANGE}`;
    const res = await fetch(url);
    const data = await res.json();

    const flights = (data.states || [])
      .filter(isCommercial)
      .map(f => {
        const lat = f[6];
        const lon = f[5];
        const callsign = (f[1] || "UNKNOWN").trim();
        const alt = Math.round((f[7] || 0) * 3.28);
        const speed = Math.round((f[9] || 0) * 1.94);
        const dist = distance(HOME_LAT, HOME_LON, lat, lon);
        const brg = bearing(HOME_LAT, HOME_LON, lat, lon);
        const airline = detectAirline(callsign);
        return { callsign, alt, speed, dist, brg, airline };
      })
      .sort((a,b) => a.dist - b.dist)
      .slice(0, 12);

    flightsCache = flights;
    status.innerText = `LIVE: ${flights.length} commercial aircraft`;
  } catch {
    status.innerText = "Radar feed error.";
  }
}

async function renderFlight() {
  if (!flightsCache.length) return;
  const flight = flightsCache[index % flightsCache.length];
  index++;

  const extra = await lookupFlight(flight.callsign);
  const overhead = flight.dist < 1.2;

  const current = document.getElementById("fw-current");
  current.innerHTML = `
    <div class="flight-header ${overhead ? "overhead" : ""}">
      ${flight.airline.logo ? `<img class="logo" src="${flight.airline.logo}">` : ""}
      ${flight.callsign}
    </div>
    <div class="flight-route">${extra.route} • ${extra.model}</div>
    <div class="flight-stats">
      <div class="stat"><span>ALT</span><span>${flight.alt.toLocaleString()} ft</span></div>
      <div class="stat"><span>SPD</span><span>${flight.speed} kt</span></div>
      <div class="stat"><span>DIST</span><span>${flight.dist.toFixed(1)} km</span></div>
      <div class="stat"><span>BRG</span><span>${flight.brg}°</span></div>
    </div>
    ${overhead ? "<div style='margin-top:8px;'>⚠ OVERHEAD AIRCRAFT</div>" : ""}
  `;

  const queue = document.getElementById("fw-queue");
  queue.innerHTML = flightsCache.slice(1,6).map(f =>
    `<div class="queue-item">
      <span>${f.callsign}</span>
      <span>${f.dist.toFixed(1)} km</span>
    </div>`
  ).join("");
}

async function init() {
  await detectLocation();
  await loadFlights();
  renderFlight();
  setInterval(loadFlights, 7000);
  setInterval(renderFlight, 3500);
}

init();
