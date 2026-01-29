// CHANGE THIS TO YOUR LOCATION
const LAT = 36.19;   // Springdale AR area
const LON = -94.13;
const RADIUS = 0.6; // ~60km

async function loadFlights() {
  const status = document.getElementById("status");
  status.innerText = "Fetching live air traffic...";

  try {
    const url = `https://opensky-network.org/api/states/all?lamin=${LAT-RADIUS}&lomin=${LON-RADIUS}&lamax=${LAT+RADIUS}&lomax=${LON+RADIUS}`;
    const res = await fetch(url);
    const data = await res.json();

    const grid = document.getElementById("flights");
    grid.innerHTML = "";

    if (!data.states || data.states.length === 0) {
      status.innerText = "No aircraft detected nearby.";
      return;
    }

    data.states.slice(0, 24).forEach(f => {
      const callsign = (f[1] || "UNKNOWN").trim();
      const alt = f[7] ? Math.round(f[7] * 3.28) : 0; // feet
      const speed = f[9] ? Math.round(f[9] * 1.94) : 0; // knots
      const lat = f[6];
      const lon = f[5];

      const div = document.createElement("div");
      div.className = "flight";
      div.innerHTML = `
        <div class="callsign">${callsign}</div>
        <div class="meta">
          ALT: <span class="value">${alt} ft</span><br>
          SPD: <span class="value">${speed} kt</span><br>
          POS: <span class="value">${lat?.toFixed(2)}, ${lon?.toFixed(2)}</span>
        </div>
      `;
      grid.appendChild(div);
    });

    status.innerText = `Tracking ${data.states.length} aircraft`;
  } catch (err) {
    status.innerText = "Error loading flight data.";
    console.error(err);
  }
}

loadFlights();
setInterval(loadFlights, 8000);