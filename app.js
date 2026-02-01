// v49 UI upgrade on top of v48 baseline
const PROXY = "https://flightsabove.t2hkmhgbwz.workers.dev/";

const XNA_FALLBACK = { lat: 36.2819, lon: -94.3068 };

let HOME_LAT = XNA_FALLBACK.lat;
let HOME_LON = XNA_FALLBACK.lon;

let RANGE_MI = 25;
let COMMERCIAL_ONLY = true;

let flights = [];
let currentIndex = 0;
let current = null;

let scrollMode = "rotate"; // rotate | closest
let rotateEveryMs = 7000;
let rotateTimer = null;
let lastDisplayedKey = null;
let hasRenderedOnce = false;


function setStatus(msg){
  const el = document.getElementById("fw-status");
  if (el && el.textContent !== msg) el.textContent = msg;
}
function setHomeLine(){
  const el = document.getElementById("homeLine");
  if (!el) return;
  el.textContent = `HOME: ${HOME_LAT.toFixed(3)}, ${HOME_LON.toFixed(3)} • RANGE: ${RANGE_MI} MI`;
}
function setFade(){
  const card = document.getElementById("card");
  if (!card) return;
  card.classList.remove("fw-fade-in");
  void card.offsetWidth;
  card.classList.add("fw-fade-in");
}
function deg2rad(d){ return d*Math.PI/180; }
function haversineMi(lat1, lon1, lat2, lon2){
  const R = 3958.7613;
  const dLat = deg2rad(lat2-lat1);
  const dLon = deg2rad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(deg2rad(lat1))*Math.cos(deg2rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function bearing(lat1, lon1, lat2, lon2){
  const φ1=deg2rad(lat1), φ2=deg2rad(lat2);
  const y=Math.sin(deg2rad(lon2-lon1))*Math.cos(φ2);
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(deg2rad(lon2-lon1));
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
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
  if (!cs) return false;
  const s = cs.trim().toUpperCase();
  if (s.length < 3) return false;
  return /^[A-Z]{2,3}\d{1,5}[A-Z]?$/.test(s);
}
function readStateRow(row){
  const callsign = (row[1] || "").trim().toUpperCase();
  const lat = row[6], lon = row[5];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const dist = haversineMi(HOME_LAT, HOME_LON, lat, lon);
  const velMs = row[9];
  const trk = row[10];
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

function updateTicker(){
  const t = document.getElementById("tickerTrack");
  if (!t) return;
  if (!flights.length){
    t.textContent = "NO TRAFFIC IN RANGE";
    return;
  }
  const items = flights.slice(0,5).map(f => {
    const d = `${f.dist.toFixed(1)}MI`;
    const a = f.altFt ? `${Math.round(f.altFt/100)*100}FT` : "—";
    const s = f.spdMph ? `${Math.round(f.spdMph)}MPH` : "—";
    return `${f.callsign || "—"} • ${d} • ${a} • ${s}`;
  });
  t.textContent = items.join("   ✦   ") + "   ✦   " + items.join("   ✦   ");
}

function pickCurrent(){
  if (!flights.length) return null;
  if (scrollMode === "closest") return flights[0];
  currentIndex = (currentIndex % flights.length + flights.length) % flights.length;
  return flights[currentIndex];
}

function render(){
  setHomeLine();

  const csEl = document.getElementById("cs");
  const routeEl = document.getElementById("route");
  const modelEl = document.getElementById("model");
  const altEl = document.getElementById("alt");
  const spdEl = document.getElementById("spd");
  const distEl = document.getElementById("dist");
  const dirEl = document.getElementById("dir");
  const metaEl = document.getElementById("meta");
  const badgeEl = document.getElementById("badge");

  if (!current){
    csEl.textContent = "—";
    routeEl.textContent = "NO NEARBY FLIGHTS";
    modelEl.textContent = "—";
    altEl.textContent = "—";
    spdEl.textContent = "—";
    distEl.textContent = "—";
    dirEl.textContent = "—";
    metaEl.textContent = "Adjust range or turn off commercial-only to see more traffic.";
    badgeEl.className = "badge estimated";
    badgeEl.textContent = "≈";
    return;
  }

  csEl.textContent = current.callsign || "UNKNOWN";
  routeEl.textContent = "—";     // route/model can be added back after we stabilize UI
  modelEl.textContent = "—";

  altEl.textContent = current.altFt ? `${Math.round(current.altFt).toLocaleString()} FT` : "—";
  spdEl.textContent = current.spdMph ? `${Math.round(current.spdMph)} MPH` : "—";
  distEl.textContent = `${current.dist.toFixed(1)} MI`;

  const b = bearing(HOME_LAT, HOME_LON, current.lat, current.lon);
  dirEl.textContent = `${dirText(b)} ${Math.round(b)}°`;

  metaEl.textContent = `COUNTRY: ${current.originCountry || "—"} • ICAO24: ${current.icao24 || "—"}`;

  badgeEl.className = "badge estimated";
  badgeEl.textContent = "≈";
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
  flights = parsed.slice(0, 5);
  current = pickCurrent();
  updateTicker();
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
      setHomeLine();
    },
    ()=>{ done=true; clearTimeout(t); },
    { enableHighAccuracy:false, maximumAge:600000, timeout:3000 }
  );
}

function hookControls(){
  const r = document.getElementById("range");
  const rl = document.getElementById("rangeLabel");
  const c = document.getElementById("commercialOnly");
  const sm = document.getElementById("scrollMode");
  const rs = document.getElementById("rotateSpeed");

  if (r && rl){
    rl.textContent = String(RANGE_MI);
    r.addEventListener("input", ()=>{
      RANGE_MI = Number(r.value) || 25;
      rl.textContent = String(RANGE_MI);
      setStatus("SCANNING AIRSPACE…");
      setHomeLine();
    });
  }

  if (c){
    c.checked = COMMERCIAL_ONLY;
    c.addEventListener("change", ()=>{
      COMMERCIAL_ONLY = !!c.checked;
      setStatus("SCANNING AIRSPACE…");
    });
  }

  if (sm){
    sm.value = scrollMode;
    sm.addEventListener("change", ()=>{
      scrollMode = sm.value;
      currentIndex = 0;
      current = pickCurrent();
    render();
    });
  }

  if (rs){
    rs.value = String(rotateEveryMs);
    rs.addEventListener("change", ()=>{
      rotateEveryMs = Number(rs.value) || 7000;
      restartRotate();
    });
  }
}

function restartRotate(){
  if (rotateTimer) clearInterval(rotateTimer);
  rotateTimer = setInterval(()=>{
    if (!flights.length) return;
    if (scrollMode !== "rotate") return;
    currentIndex = (currentIndex + 1) % flights.length;
    current = pickCurrent();
    const key = (current && current.callsign) ? current.callsign : String(currentIndex);
    if (key !== lastDisplayedKey){ lastDisplayedKey = key; setFade(); }
    render();
  }, rotateEveryMs);
}

let ticking = false;
async function tick(){
  if (ticking) return;
  ticking = true;
  try{
    await loadFlights();
    // Only animate when the displayed flight changes (prevents flashing)
    const key = (current && current.callsign) ? current.callsign : String(currentIndex);
    if (key !== lastDisplayedKey){ lastDisplayedKey = key; if (hasRenderedOnce) setFade(); }

    if (flights.length){
      setStatus(`TRACKING ${flights.length} CLOSEST FLIGHT${flights.length===1?"":"S"}…`);
    } else {
      setStatus("NO NEARBY FLIGHTS");
    }
    setFade();
    render();
    hasRenderedOnce = true;
  }catch(e){
    setStatus("RADAR TEMPORARILY UNAVAILABLE");
    render();
  }finally{
    ticking = false;
  }
}

function start(){
  document.getElementById("fw-version").textContent = "v50";
  hookControls();
  detectLocation(); // doesn't block
  setStatus("SCANNING AIRSPACE…");
  render();
  tick();
  setInterval(tick, 3000);
  restartRotate();
}

document.addEventListener("DOMContentLoaded", start);
