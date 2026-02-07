// FlightsAboveMe UI (v1.1.3 baseline)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const POLL_MS = 3500;

const enrichCache = new Map();

function $(id){ return document.getElementById(id); }

function setStatus(text){
  $("statusText").textContent = text || "";
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
  // Keep your original idea: small-ish bbox to avoid overload.
  const dLat = 0.6;
  const dLon = 0.8;
  return {
    lamin: (lat - dLat).toFixed(4),
    lamax: (lat + dLat).toFixed(4),
    lomin: (lon - dLon).toFixed(4),
    lomax: (lon + dLon).toFixed(4),
  };
}

async function fetchJSON(url, timeoutMs=9000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, {
      method:"GET",
      headers:{ "accept":"application/json" },
      signal: ctrl.signal,
      cache: "no-store",
    });

    if (!res.ok) {
      // Try JSON body first, then text, so you SEE why it failed.
      let body = "";
      try {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const j = await res.json();
          body = j?.error || j?.detail || JSON.stringify(j);
        } else {
          body = await res.text();
        }
      } catch {
        // ignore parsing errors
      }
      body = (body || "").toString().trim();
      const suffix = body ? ` — ${body}` : "";
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

function fmtDist(meters){
  if (meters == null) return "—";
  const mi = meters / 1609.344;
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

function renderPrimary(f, radarMeta){
  if (!f) return;

  $("callsign").textContent = (f.callsign || "—").trim() || "—";
  $("route").textContent = f.route || f.originDest || "—";
  $("model").textContent = f.aircraftType || f.model || f.typeName || "—";
  $("icao24").textContent = (f.icao24 || "—").toLowerCase();

  const inferredAirline = f.airlineName || f.airlineGuess || guessAirline(f.callsign);
  $("airline").textContent = inferredAirline || "Unknown Airline";

  if (f.airlineIcao) setLogo(f.airlineIcao);
  else if (f.airlineIata) setLogo(f.airlineIata);
  else setLogo(guessAirline(f.callsign));

  $("alt").textContent = fmtAlt(f.altitudeM);
  $("spd").textContent = fmtSpd(f.velocityMs);
  $("dist").textContent = fmtDist(f.distanceM);
  $("dir").textContent = fmtDir(f.trackDeg);

  $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;

  // Per your requirement:
  $("debugLine").textContent = "API 1.1";
}

function renderList(list){
  const el = $("list");
  el.innerHTML = "";
  list.forEach((f)=>{
    const row = document.createElement("div");
    row.className = "row";
    const cs = (f.callsign || "—").trim() || "—";
    const dist = fmtDist(f.distanceM);
    const alt = fmtAlt(f.altitudeM);
    const spd = fmtSpd(f.velocityMs);

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

let tier = "A";
function setupTier(){
  const seg = $("tierSegment");
  if (!seg) return;
  seg.addEventListener("click", (e)=>{
    const btn = e.target.closest("button[data-tier]");
    if (!btn) return;
    tier = btn.dataset.tier;
    seg.querySelectorAll("button").forEach(b=>b.classList.toggle("active", b === btn));
  });
}

async function startRadar(lat, lon){
  const bb = bboxAround(lat, lon);

  async function tick(){
    try{
      setErr("");
      setStatus("Radar…");

      const url = new URL(`${API_BASE}/opensky/states`);
      Object.entries(bb).forEach(([k,v])=>url.searchParams.set(k,v));
      url.searchParams.set("tier", tier); // harmless if worker ignores; useful if it supports

      const data = await fetchJSON(url.toString(), 9000);
      const flights = Array.isArray(data?.flights) ? data.flights : [];

      const radarMeta = {
        count: data?.count ?? flights.length,
        showing: Math.min(flights.length, 5),
      };

      if (flights[0]) renderPrimary(flights[0], radarMeta);
      renderList(flights.slice(0,5));

      setStatus("Live");
    } catch (err){
      setStatus("Error");
      setErr(err?.message || String(err));
    }
  }

  tick();
  setInterval(tick, POLL_MS);
}

function boot(){
  setupTier();
  setStatus("Requesting location…");
  setErr("");

  if (!navigator.geolocation) {
    setStatus("Error");
    setErr("Geolocation is not available in this browser.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos)=>{
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      setStatus("Location OK");
      startRadar(lat, lon);
    },
    (err)=>{
      setStatus("Error");
      setErr(`Location error: ${err?.message || err}`);
    },
    { enableHighAccuracy:false, timeout:10000, maximumAge:60000 }
  );
}

boot();