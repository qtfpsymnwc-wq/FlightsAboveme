// v48 minimal single-script build
// IMPORTANT: set your Worker URL here (must end with /)
const PROXY = "https://flightsabove.t2hkmhgbwz.workers.dev/";

const XNA_FALLBACK = { lat: 36.2819, lon: -94.3068 };

let HOME_LAT = XNA_FALLBACK.lat;
let HOME_LON = XNA_FALLBACK.lon;

let RANGE_MI = 25;
let COMMERCIAL_ONLY = true;

let flights = [];
let current = null;

// --- helpers
function setStatus(msg){
  const el = document.getElementById("fw-status");
  if (el) el.textContent = msg;
}
function setVersion(){
  const el = document.getElementById("fw-version");
  if (el) el.textContent = "v48";
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function deg2rad(d){ return d*Math.PI/180; }

function haversineMi(lat1, lon1, lat2, lon2){
  const R = 3958.7613; // miles
  const dLat = deg2rad(lat2-lat1);
  const dLon = deg2rad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(deg2rad(lat1))*Math.cos(deg2rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function bearing(lat1, lon1, lat2, lon2){
  const φ1=deg2rad(lat1), φ2=deg2rad(lat2);
  const λ1=deg2rad(lon1), λ2=deg2rad(lon2);
  const y=Math.sin(λ2-λ1)*Math.cos(φ2);
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
  let brng=(Math.atan2(y,x)*180/Math.PI+360)%360;
  return brng;
}
function dirText(deg){
  if (!Number.isFinite(deg)) return "—";
  const dirs=["N","NE","E","SE","S","SW","W","NW","N"];
  return dirs[Math.round(deg/45)];
}

async function fetchWithTimeout(url, ms=6500){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  try{
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    return res;
  }catch(e){
    clearTimeout(t);
    throw e;
  }
}

function milesToDegLat(mi){ return mi/69.0; }
function milesToDegLon(mi, lat){ return mi/(Math.cos(deg2rad(lat))*69.172); }

function looksCommercial(cs){
  // Heuristic only; avoids obvious GA / missing callsigns
  if (!cs) return false;
  const s = cs.trim().toUpperCase();
  if (s.length < 3) return false;
  // common airline-ish patterns: 2-3 letters then digits
  return /^[A-Z]{2,3}\d{1,5}[A-Z]?$/.test(s);
}

function readStateRow(row){
  // OpenSky states array format:
  // [0]icao24, [1]callsign, [2]origin_country, [3]time_position, [4]last_contact,
  // [5]lon, [6]lat, [7]baro_altitude(m), [8]on_ground, [9]velocity(m/s),
  // [10]true_track, [11]vertical_rate, [12]sensors, [13]geo_altitude(m), ...
  const callsign = (row[1] || "").trim();
  const lat = row[6], lon = row[5];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const dist = haversineMi(HOME_LAT, HOME_LON, lat, lon);
  const trk = row[10];
  const velMs = row[9];
  const altM = (Number.isFinite(row[13]) ? row[13] : row[7]);

  return {
    callsign,
    lat, lon,
    dist,
    trk,
    spdMph: Number.isFinite(velMs) ? velMs*2.236936 : null,
    altFt: Number.isFinite(altM) ? altM*3.28084 : null,
    originCountry: row[2] || "",
    icao24: row[0] || ""
  };
}

function pickCurrent(){
  if (!flights.length) return null;
  flights.sort((a,b)=>a.dist-b.dist);
  return flights[0];
}

function render(){
  setVersion();

  const csEl = document.getElementById("cs");
  const routeEl = document.getElementById("route");
  const modelEl = document.getElementById("model");
  const altEl = document.getElementById("alt");
  const spdEl = document.getElementById("spd");
  const distEl = document.getElementById("dist");
  const dirEl = document.getElementById("dir");
  const metaEl = document.getElementById("meta");
  const badgeEl = document.getElementById("badge");
  const ticker = document.getElementById("tickerTrack");

  if (!current){
    csEl.textContent = "—";
    routeEl.textContent = "No nearby flights";
    modelEl.textContent = "—";
    altEl.textContent = "—";
    spdEl.textContent = "—";
    distEl.textContent = "—";
    dirEl.textContent = "—";
    metaEl.textContent = `Home: ${HOME_LAT.toFixed(3)}, ${HOME_LON.toFixed(3)} • Range: ${RANGE_MI} mi`;
    badgeEl.className = "badge estimated";
    badgeEl.textContent = "≈";
  } else {
    csEl.textContent = current.callsign || "UNKNOWN";
    routeEl.textContent = "—";      // This minimal build does not call paid route APIs
    modelEl.textContent = "—";
    altEl.textContent = current.altFt ? `${Math.round(current.altFt).toLocaleString()} ft` : "—";
    spdEl.textContent = current.spdMph ? `${Math.round(current.spdMph)} mph` : "—";
    distEl.textContent = `${current.dist.toFixed(1)} mi`;
    const b = bearing(HOME_LAT, HOME_LON, current.lat, current.lon);
    dirEl.textContent = `${dirText(b)} (${Math.round(b)}°)`;
    metaEl.textContent = `Country: ${current.originCountry || "—"} • ICAO24: ${current.icao24 || "—"}`;
    badgeEl.className = "badge estimated";
    badgeEl.textContent = "≈";
  }

  // ticker: list top 5 closest
  if (ticker){
    if (!flights.length){
      ticker.textContent = "NO TRAFFIC IN RANGE";
    } else {
      const items = flights.slice(0,5).map(f => {
        const d = `${f.dist.toFixed(1)}mi`;
        const a = f.altFt ? `${Math.round(f.altFt/100)*100}ft` : "—";
        return `${f.callsign || "—"} • ${d} • ${a}`;
      });
      // repeat twice for smooth loop
      ticker.textContent = items.join("   ✦   ") + "   ✦   " + items.join("   ✦   ");
    }
  }
}

async function loadFlights(){
  const dLat = milesToDegLat(RANGE_MI);
  const dLon = milesToDegLon(RANGE_MI, HOME_LAT);
  const lamin = (HOME_LAT - dLat).toFixed(4);
  const lamax = (HOME_LAT + dLat).toFixed(4);
  const lomin = (HOME_LON - dLon).toFixed(4);
  const lomax = (HOME_LON + dLon).toFixed(4);

  const url = `${PROXY}opensky/states?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;

  const res = await fetchWithTimeout(url, 6500);
  if (!res.ok) throw new Error(`OpenSky ${res.status}`);
  const js = await res.json();

  const rows = Array.isArray(js?.states) ? js.states : [];
  const parsed = [];
  for (const r of rows){
    const f = readStateRow(r);
    if (!f) continue;
    if (f.dist > RANGE_MI) continue;
    if (COMMERCIAL_ONLY && !looksCommercial(f.callsign)) continue;
    parsed.push(f);
  }

  parsed.sort((a,b)=>a.dist-b.dist);
  flights = parsed.slice(0, 5); // keep 5 closest
  current = pickCurrent();
}

function detectLocation(){
  if (!navigator.geolocation) return;
  let done = false;
  const t = setTimeout(()=>{ done=true; }, 3000);
  navigator.geolocation.getCurrentPosition(
    (pos)=>{
      if (done) return;
      done = true; clearTimeout(t);
      HOME_LAT = pos.coords.latitude;
      HOME_LON = pos.coords.longitude;
    },
    ()=>{ done=true; clearTimeout(t); },
    { enableHighAccuracy:false, maximumAge:600000, timeout:3000 }
  );
}

function hookControls(){
  const r = document.getElementById("range");
  const rl = document.getElementById("rangeLabel");
  const c = document.getElementById("commercialOnly");

  if (r && rl){
    rl.textContent = String(RANGE_MI);
    r.addEventListener("input", ()=>{
      RANGE_MI = Number(r.value) || 25;
      rl.textContent = String(RANGE_MI);
      setStatus("Scanning airspace…");
    });
  }
  if (c){
    c.addEventListener("change", ()=>{
      COMMERCIAL_ONLY = !!c.checked;
      setStatus("Scanning airspace…");
    });
  }
}

let ticking = false;
async function tick(){
  if (ticking) return;
  ticking = true;
  try{
    await loadFlights();
    if (flights.length){
      setStatus(`Tracking ${flights.length} closest flight${flights.length===1?"":"s"}…`);
    } else {
      setStatus("No nearby flights");
    }
    render();
  }catch(e){
    setStatus("Radar temporarily unavailable");
    render();
  }finally{
    ticking = false;
  }
}

function start(){
  setVersion();
  hookControls();
  detectLocation(); // async; doesn't block
  setStatus("Scanning airspace…");
  render();
  tick();
  setInterval(tick, 3000);
}

window.addEventListener("error", (e)=>{
  setStatus(`JS ERROR: ${e.message || "unknown"}`);
});

window.addEventListener("unhandledrejection", (e)=>{
  const m = e?.reason?.message || String(e?.reason || "unknown");
  setStatus(`PROMISE ERROR: ${m}`);
});

document.addEventListener("DOMContentLoaded", start);
