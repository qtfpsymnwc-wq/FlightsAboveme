const HOME_LAT = 36.19;
const HOME_LON = -94.13;
const RANGE = 0.7;

// Airline prefix → airline + logo
const AIRLINES = {
  AAL: { name: "American", logo: "https://logo.clearbit.com/aa.com" },
  DAL: { name: "Delta", logo: "https://logo.clearbit.com/delta.com" },
  UAL: { name: "United", logo: "https://logo.clearbit.com/united.com" },
  SWA: { name: "Southwest", logo: "https://logo.clearbit.com/southwest.com" },
  FFT: { name: "Frontier", logo: "https://logo.clearbit.com/flyfrontier.com" },
  JBU: { name: "JetBlue", logo: "https://logo.clearbit.com/jetblue.com" },
  ASA: { name: "Alaska", logo: "https://logo.clearbit.com/alaskaair.com" },
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

function guessAircraftType(speed) {
  if (speed > 450) return "B737 / A320";
  if (speed > 350) return "E175 / A220";
  if (speed > 250) return "Turboprop";
  return "GA Aircraft";
}

function detectAirline(callsign) {
  const prefix = callsign.slice(0,3);
  return AIRLINES[prefix] || { name: "Unknown", logo: "" };
}

async function loadFlights() {
  const status = document.getElementById("fw-status");

  try {
    const url = `https://opensky-network.org/api/states/all?lamin=${HOME_LAT-RANGE}&lomin=${HOME_LON-RANGE}&lamax=${HOME_LAT+RANGE}&lomax=${HOME_LON+RANGE}`;
    const res = await fetch(url);
    const data = await res.json();

    const rows = document.getElementById("fw-rows");
    rows.innerHTML = "";

    if (!data.states) {
      status.innerText = "No aircraft detected.";
      return;
    }

    const flights = data.states
      .map(f => {
        const lat = f[6];
        const lon = f[5];
        if (!lat || !lon) return null;

        const callsign = (f[1] || "UNKNOWN").trim();
        const alt = Math.round((f[7] || 0) * 3.28);
        const speed = Math.round((f[9] || 0) * 1.94);
        const dist = distance(HOME_LAT, HOME_LON, lat, lon);

        const airline = detectAirline(callsign);
        const type = guessAircraftType(speed);

        return { callsign, alt, speed, dist, brg: bearing(HOME_LAT, HOME_LON, lat, lon), airline, type };
      })
      .filter(Boolean)
      .sort((a,b) => a.dist - b.dist)
      .slice(0, 18);

    flights.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "fw-row" + (i === 0 ? " closest" : "");

      row.innerHTML = `
        <span>
          ${f.airline.logo ? `<img class="logo" src="${f.airline.logo}">` : ""}
          ${f.airline.name}
        </span>
        <span>${f.callsign}</span>
        <span>${f.type}</span>
        <span>${f.alt}ft</span>
        <span>${f.speed}kt</span>
        <span>${f.dist.toFixed(1)}km</span>
        <span>${f.brg}°</span>
      `;
      rows.appendChild(row);
    });

    status.innerText = `LIVE: ${flights.length} aircraft | Closest: ${flights[0]?.callsign}`;

  } catch (e) {
    console.error(e);
    status.innerText = "Radar feed error (OpenSky limit).";
  }
}

loadFlights();
setInterval(loadFlights, 5000);
