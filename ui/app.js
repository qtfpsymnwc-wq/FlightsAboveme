// FlightWall UI (v170)
// Option A: Pages hosts this UI, Worker hosts API.
// Set API_BASE to your Worker domain. (No trailing slash)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v180";
const POLL_MS = 3500;

// Persist Aerodatabox + aircraft enrichments across refreshes.
// Keyed by icao24 + callsign to avoid "route flashes then disappears".
// Key: `${icao24}|${callsign}`
const enrichCache = new Map();

function $(id){ return document.getElementById(id); }

function showErr(msg){
  const box = $("errBox");
  if (!box) return;
  box.classList.remove("hidden");
  box.textContent = msg;
}

function hideErr(){
  const box = $("errBox");
  if (!box) return;
  box.classList.add("hidden");
  box.textContent = "";
}

function haversineMi(lat1, lon1, lat2, lon2){
  const R = 3958.7613;
  const toRad = (d)=>d*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
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

async function fetchJSON(url, timeoutMs=8000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method:"GET",
      headers:{ "accept":"application/json" },
      signal: ctrl.signal
    });
    if (!res.ok) {
      // Try to read JSON error for clarity
      let detail = "";
      try {
        const j = await res.json();
        detail = j?.error || j?.detail || j?.hint || "";
      } catch {}
      const suffix = detail ? ` (${detail})` : "";
      throw new Error(`HTTP ${res.status}${suffix}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function fmtAlt(m){
  if (m == null) return "—";
  const ft = Math.round(m * 3.28084);
  return `${ft.toLocaleString()} ft`;
}

function fmtSpd(ms){
  if (ms == null) return "—";
  const mph = Math.round(ms * 2.23694);
  return `${mph.toLocaleString()} mph`;
}

function fmtMi(mi){
  if (mi == null) return "—";
  return `${Math.round(mi)} mi`;
}

function fmtDir(deg){
  if (deg == null) return "—";
  const d = Math.round(deg);
  const dirs = ["N","NE","E","SE","S","SW","W","NW","N"];
  const idx = Math.round(d / 45);
  const label = dirs[idx] || "—";
  return `${label} (${d}°)`;
}

function guessAirline(callsign){
  // legacy placeholder; server-side logic should handle this.
  if (!callsign) return "";
  return callsign.trim().slice(0,3).toUpperCase();
}

function setLogo(code){
  const img = $("airlineLogo");
  if (!img) return;

  const safe = (code || "").trim().toUpperCase();
  if (!safe) {
    img.classList.add("hidden");
    img.removeAttribute("src");
    return;
  }

  img.classList.remove("hidden");
  img.dataset.fallbackDone = "";
  img.onerror = () => {
    if (img.dataset.fallbackDone) return;
    img.dataset.fallbackDone = "1";
    img.src = "./assets/logos/_GENERIC.svg";
  };
  img.src = `./assets/logos/${safe}.svg`;
}

function normalizeCallsign(cs){
  return (cs || "").trim().replace(/\s+/g,"").toUpperCase();
}

function renderPrimary(f, radarMeta){
  if (!f) return;

  const cs = (f.callsign || "—").trim() || "—";
  const route = f.route || "—";
  const model = f.model || f.typeName || f.aircraftType || "—";

  $("callsign").textContent = cs;
  $("route").textContent = route;
  $("model").textContent = model;
  $("icao24").textContent = (f.icao24 || "—").toLowerCase();

  const inferredAirline = f.airlineName || f.airlineGuess || guessAirline(f.callsign);
  const countryFallback = (f.country && f.country !== "United States") ? f.country : "—";
  $("airline").textContent = inferredAirline || countryFallback;

  // logo prefers explicit codes, else callsign prefix
  try {
    if (f.airlineIcao) setLogo(f.airlineIcao);
    else if (f.airlineIata) setLogo(f.airlineIata);
    else setLogo(guessAirline(f.callsign));
  } catch {
    setLogo("");
  }

  $("alt").textContent = fmtAlt(f.altitudeM ?? f.baroAlt);
  $("spd").textContent = fmtSpd(f.velocityMs ?? f.velocity);
  $("dist").textContent = fmtMi(f.distanceMi ?? (f.distanceM != null ? (f.distanceM/1609.344) : null));
  $("dir").textContent = fmtDir(f.trackDeg ?? f.track);

  $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;

  // ✅ ONLY CHANGE REQUESTED: remove UI version and call API version 1.1
  $("debugLine").textContent = `API 1.1`;
}

function renderList(list){
  const el = $("list");
  el.innerHTML = "";
  list.forEach((f)=>{
    const row = document.createElement("div");
    row.className = "row";
    const cs = (f.callsign || "—").trim() || "—";
    const dist = fmtMi(f.distanceMi ?? (f.distanceM != null ? (f.distanceM/1609.344) : null));
    const alt = fmtAlt(f.altitudeM ?? f.baroAlt);
    const spd = fmtSpd(f.velocityMs ?? f.velocity);
    row.innerHTML = `
      <div class="left">
        <div class="cs">${cs}</div>
        <div class="sub">${dist} • ${alt} • ${spd}</div>
      </div>
      <div class="badge">${(f.icao24||"").toLowerCase()}</div>
    `;
    el.appendChild(row);
  });
}

function boot(){
  hideErr();
  $("statusText").textContent = "Requesting location…";

  navigator.geolocation.getCurrentPosition(async (pos)=>{
    hideErr();
    $("statusText").textContent = "Location OK";

    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const bb = bboxAround(lat, lon);

    $("statusText").textContent = "Radar…";

    let lastPrimaryKey = "";

    async function tick(){
      try {
        hideErr();

        const url = new URL(`${API_BASE}/opensky/states`);
        Object.entries(bb).forEach(([k,v])=>url.searchParams.set(k,v));

        const data = await fetchJSON(url.toString(), 9000);
        const flights = Array.isArray(data?.flights) ? data.flights : [];
        const count = data?.count ?? flights.length;
        const showing = Math.min(flights.length, 5);

        const radarMeta = {
          count,
          showing,
          apiVersion: data?.apiVersion
        };

        // enrich cache merge (if worker sends enrichments or later UI does)
        flights.forEach((f)=>{
          const key = `${(f.icao24||"").toLowerCase()}|${normalizeCallsign(f.callsign)}`;
          const cached = enrichCache.get(key);
          if (cached) Object.assign(f, cached);
        });

        const primary = flights[0] || null;
        if (primary) {
          const key = `${(primary.icao24||"").toLowerCase()}|${normalizeCallsign(primary.callsign)}`;
          if (!lastPrimaryKey || lastPrimaryKey !== key) {
            lastPrimaryKey = key;
          }
          renderPrimary(primary, radarMeta);
        }

        renderList(flights.slice(0,5));
        $("statusText").textContent = "Live";
      } catch (e) {
        $("statusText").textContent = "Error";
        showErr(String(e.message || e));
      }
    }

    tick();
    setInterval(tick, POLL_MS);

  }, (err)=>{
    $("statusText").textContent = "Location failed";
    showErr(String(err.message || err));
  }, {
    enableHighAccuracy: false,
    timeout: 10000,
    maximumAge: 60000,
  });
}

boot();