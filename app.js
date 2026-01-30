// ===== CONFIG =====
const HOME_LAT = 36.19;
const HOME_LON = -94.13;
const RANGE = 0.7;      // search radius (~70km)
const OVERHEAD_KM = 1.2; // overhead alert distance

// Airline logos via AirHex CDN (stable)
const AIRLINES = {
  AAL: { name: "American Airlines", icao: "AAL" },
  DAL: { name: "Delta Air Lines", icao: "DAL" },
  UAL: { name: "United Airlines", icao: "UAL" },
  SWA: { name: "Southwest Airlines", icao: "SWA" },
  JBU: { name: "JetBlue", icao: "JBU" },
  FFT: { name: "Frontier Airlines", icao: "FFT" },
  ASA: { name: "Alaska Airlines", icao: "ASA" },
};

function logoUrl(icao) {
  return `https://content.airhex.com/content/logos/airlines_${icao}_200_200_s.png`;
}

// Distance (Haversine)
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

// Bearing
function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2-lon1)*Math.PI/180) * Math.cos(lat2*Math.PI/180);
  const x =
    Math.cos(lat1*Math.PI/180)*Math.sin(lat2*Math.PI/180) -
    Math.sin(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180) *
    Math.cos((lon2-lon1)*Math.PI/180);
  return Math.round((Math.atan2(y, x) * 180/Math.PI + 360) % 360);
}

// Guess aircraft type fallback
function guessAircraftType(speed) {
  if (speed > 460) return "Narrowbody Jet (A320/B737)";
  if (speed > 360) return "Regional Jet (E175/CRJ)";
  if (speed > 250) return "Turboprop";
  return "General Aviation";
}

function detectAirline(callsign) {
  const prefix = callsign.slice(0,3);
  return AIRLINES[prefix] || { name: "Unknown", icao: null };
}

// ADSBdb lookup for exact aircraft + route
async function lookupADSB(callsign) {
  try {
    const res = await fetch(`https://api.adsbdb.com/v0/callsign/${callsign}`);
    const json = await res.json();
    if (json && json.response && json.response.aircraft) {
      const ac = json.response.aircraft;
      return {
        model: ac.model || null,
        manufacturer: ac.manufacturer || null,
        origin: json.response.route?.origin?.iata || null,
        destination: json.response.route?.destination?.iata || null,
      };
    }
  } catch (e) {}
  return null;
}

let flights = [];
let index = 0;

async function loadFlights() {
  const status = document.getElementById("fw-status");
  try {
    const url = `https://opensky-network.org/api/states/all?lamin=${HOME_LAT-RANGE}&lomin=${HOME_LON-RANGE}&lamax=${HOME_LAT+RANGE}&lomax=${HOME_LON+RANGE}`;
    const res = await fetch(url);
    const data = await res.json();

    flights = (data.states || [])
      .map(f => {
        const lat = f[6];
        const lon = f[5];
        if (!lat || !lon) return null;

        const callsign = (f[1] || "UNKNOWN").trim();
        const alt = Math.round((f[7] || 0) * 3.28);
        const speed = Math.round((f[9] || 0) * 1.94);
        const dist = distance(HOME_LAT, HOME_LON, lat, lon);
        const brg = bearing(HOME_LAT, HOME_LON, lat, lon);

        const airline = detectAirline(callsign);
        return { callsign, alt, speed, dist, brg, airline };
      })
      .filter(Boolean)
      .sort((a,b) => a.dist - b.dist);

    status.innerText = `Tracking ${flights.length} aircraft`;
    updateTicker();
  } catch (e) {
    console.error(e);
    status.innerText = "OpenSky feed error";
  }
}

async function showFlight() {
  if (!flights.length) return;

  const f = flights[index % flights.length];
  index++;

  const card = document.getElementById("flight-card");
  card.style.opacity = 0;
  card.style.transform = "scale(0.97)";

  // ADSB lookup (async, non-blocking)
  let model = null, route = null;
  const adsb = await lookupADSB(f.callsign);
  if (adsb) {
    model = adsb.model || null;
    if (adsb.origin && adsb.destination) {
      route = `${adsb.origin} → ${adsb.destination}`;
    }
  }

  setTimeout(() => {
    document.getElementById("callsign").innerText = f.callsign;
    document.getElementById("aircraft-type").innerText = model || guessAircraftType(f.speed);
    document.getElementById("route").innerText = route || "Route unavailable";
    document.getElementById("altitude").innerText = f.alt + " ft";
    document.getElementById("speed").innerText = f.speed + " kt";
    document.getElementById("distance").innerText = f.dist.toFixed(1) + " km";
    document.getElementById("bearing").innerText = f.brg + "°";

    const airlineName = f.airline.name;
    document.getElementById("airline-name").innerText = airlineName;

    const logo = document.getElementById("airline-logo");
    if (f.airline.icao) {
      logo.src = logoUrl(f.airline.icao);
      logo.style.display = "block";
    } else {
      logo.style.display = "none";
    }

    // Overhead alert
    const alert = document.getElementById("alert");
    if (f.dist < OVERHEAD_KM && f.alt > 5000) {
      alert.style.display = "block";
    } else {
      alert.style.display = "none";
    }

    card.style.opacity = 1;
    card.style.transform = "scale(1)";
  }, 250);
}

function updateTicker() {
  const ticker = document.getElementById("ticker-text");
  ticker.innerText = flights.slice(0,10).map(f => f.callsign).join(" • ");
}

loadFlights();
showFlight();

setInterval(loadFlights, 15000);
setInterval(showFlight, 3500);
