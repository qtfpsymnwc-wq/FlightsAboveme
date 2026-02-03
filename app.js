// FlightWall app.js (v131)
// Proxy origin is automatically inferred — no config edits required
const FW_PROXY_ORIGIN = location.origin;

const FW_STABLE_AIR_MS = 5000;

let lastStableHex = null;
let stableSince = 0;
let aircraftCache = new Map();

async function fetchAircraft(hex) {
  if (aircraftCache.has(hex)) return aircraftCache.get(hex);

  try {
    const res = await fetch(`${FW_PROXY_ORIGIN}/aircraft/icao24/${hex}`);
    if (!res.ok) return null;
    const data = await res.json();
    aircraftCache.set(hex, data);
    return data;
  } catch {
    return null;
  }
}

// Example hook: call this when your primary/closest flight updates
export async function updatePrimaryFlight(flight) {
  const detailsEl = document.getElementById("aircraft-details");
  const primaryEl = document.getElementById("primary-flight");

  if (!flight || !flight.icao24) return;

  primaryEl.textContent = `${flight.callsign || flight.icao24} · ${flight.altitude || ""} ft`;

  const now = Date.now();
  if (flight.icao24 !== lastStableHex) {
    lastStableHex = flight.icao24;
    stableSince = now;
    detailsEl.textContent = "Aircraft: …";
    return;
  }

  if (now - stableSince < FW_STABLE_AIR_MS) return;

  const ac = await fetchAircraft(flight.icao24);
  if (!ac) return;

  const model =
    ac.model ||
    ac.aircraftModel ||
    ac.typeName ||
    "Unknown aircraft";

  const reg =
    ac.registration ||
    ac.reg ||
    "";

  detailsEl.textContent = reg ? `Aircraft: ${model} (${reg})` : `Aircraft: ${model}`;
}
