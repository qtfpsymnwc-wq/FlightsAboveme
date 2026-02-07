// FlightsAboveMe UI — v1.1.3 baseline (API version removed)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const POLL_MS = 3500;

function $(id){ return document.getElementById(id); }

function setStatus(text){
  const el = $("statusText");
  if (el) el.textContent = text || "";
}

function setErr(msg){
  const box = $("errBox");
  if (!box) return;
  if (!msg) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.classList.remove("hidden");
  box.textContent = msg;
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

async function fetchJSON(url, timeoutMs=20000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, {
      method:"GET",
      headers:{ "accept":"application/json" },
      signal: ctrl.signal,
      cache:"no-store",
    });

    if (!res.ok) {
      let body = "";
      try {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const j = await res.json();
          body = j?.error || j?.detail || JSON.stringify(j);
        } else {
          body = await res.text();
        }
      } catch {}
      throw new Error(`HTTP ${res.status}${body ? " — " + body : ""}`);
    }

    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function fmtAlt(m){
  if (m == null) return "—";
  return `${Math.round(m * 3.28084).toLocaleString()} ft`;
}
function fmtSpd(ms){
  if (ms == null) return "—";
  return `${Math.round(ms * 2.23694).toLocaleString()} mph`;
}
function fmtDist(m){
  if (m == null) return "—";
  return `${Math.round(m / 1609.344)} mi`;
}
function fmtDir(deg){
  if (deg == null) return "—";
  const d = Math.round(deg);
  const dirs = ["N","NE","E","SE","S","SW","W","NW","N"];
  return `${dirs[Math.round(d / 45)]} (${d}°)`;
}

function guessAirline(cs){
  return cs ? cs.trim().slice(0,3).toUpperCase() : "";
}

function setLogo(code){
  const img = $("airlineLogo");
  if (!img) return;

  if (!code) {
    img.classList.add("hidden");
    img.removeAttribute("src");
    return;
  }

  img.classList.remove("hidden");
  img.onerror = () => img.src = "./assets/logos/_GENERIC.svg";
  img.src = `./assets/logos/${code}.svg`;
}

function renderPrimary(f, meta){
  if (!f) return;

  $("callsign").textContent = f.callsign || "—";
  $("route").textContent = f.route || "—";
  $("model").textContent = f.aircraftType || f.model || "—";
  $("icao24").textContent = (f.icao24 || "—").toLowerCase();

  const airline = f.airlineName || guessAirline(f.callsign);
  $("airline").textContent = airline || "Unknown Airline";
  setLogo(f.airlineIcao || f.airlineIata || guessAirline(f.callsign));

  $("alt").textContent = fmtAlt(f.altitudeM);
  $("spd").textContent = fmtSpd(f.velocityMs);
  $("dist").textContent = fmtDist(f.distanceM);
  $("dir").textContent = fmtDir(f.trackDeg);

  $("radarLine").textContent =
    `Radar: ${meta.count} flights • Showing: ${meta.showing}`;
}

function renderList(list){
  const el = $("list");
  el.innerHTML = "";
  list.forEach(f=>{
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="left">
        <div class="cs">${f.callsign || "—"}</div>
        <div class="sub">
          ${fmtDist(f.distanceM)} • ${fmtAlt(f.altitudeM)} • ${fmtSpd(f.velocityMs)}
        </div>
      </div>
      <div class="badge">${(f.icao24||"").toLowerCase()}</div>
    `;
    el.appendChild(row);
  });
}

let inFlight = false;

async function startRadar(lat, lon){
  const bb = bboxAround(lat, lon);

  async function tick(){
    if (inFlight) return;
    inFlight = true;

    try{
      setErr("");
      setStatus("Radar…");

      const url = new URL(`${API_BASE}/opensky/states`);
      Object.entries(bb).forEach(([k,v])=>url.searchParams.set(k,v));

      const data = await fetchJSON(url.toString());
      const flights = data.flights || [];

      if (flights[0]) {
        renderPrimary(flights[0], {
          count: data.count ?? flights.length,
          showing: Math.min(flights.length, 5),
        });
      }

      renderList(flights.slice(0,5));
      setStatus("Live");
    } catch (e){
      setStatus("Error");
      setErr(e.message || String(e));
    } finally {
      inFlight = false;
    }
  }

  tick();
  setInterval(tick, POLL_MS);
}

function boot(){
  setStatus("Requesting location…");
  navigator.geolocation.getCurrentPosition(
    pos => startRadar(pos.coords.latitude, pos.coords.longitude),
    err => {
      setStatus("Error");
      setErr(err.message);
    },
    { timeout:10000, maximumAge:60000 }
  );
}

boot();