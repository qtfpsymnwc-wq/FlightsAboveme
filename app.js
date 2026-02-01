// v49 UI upgrade on top of v48 baseline
const PROXY = "https://flightsabove.t2hkmhgbwz.workers.dev/";


// v54: city names + airline logos + best-effort aircraft model
const AIRPORT_CITY = {
  // Northwest Arkansas + nearby
  XNA:"Fayetteville/Bentonville, AR", FYV:"Fayetteville, AR", ROG:"Rogers, AR", BVX:"Batesville, AR",
  FSM:"Fort Smith, AR", LIT:"Little Rock, AR", TUL:"Tulsa, OK", MKO:"Muskogee, OK", OKC:"Oklahoma City, OK",
  ICT:"Wichita, KS", MCI:"Kansas City, MO", JLN:"Joplin, MO", SGF:"Springfield, MO", STL:"St. Louis, MO",
  MEM:"Memphis, TN", BNA:"Nashville, TN", MSY:"New Orleans, LA",
  // Major US hubs and popular destinations
  ATL:"Atlanta, GA", ORD:"Chicago, IL", MDW:"Chicago (Midway), IL", DEN:"Denver, CO",
  DFW:"Dallas–Fort Worth, TX", DAL:"Dallas (Love), TX", IAH:"Houston, TX", HOU:"Houston (Hobby), TX",
  PHX:"Phoenix, AZ", LAS:"Las Vegas, NV", SLC:"Salt Lake City, UT",
  LAX:"Los Angeles, CA", SFO:"San Francisco, CA", OAK:"Oakland, CA", SAN:"San Diego, CA", SJC:"San Jose, CA",
  SNA:"Orange County, CA", BUR:"Burbank, CA", SMF:"Sacramento, CA", SEA:"Seattle, WA", PDX:"Portland, OR",
  JFK:"New York, NY", LGA:"New York (LaGuardia), NY", EWR:"Newark, NJ", BOS:"Boston, MA",
  IAD:"Washington Dulles, VA", DCA:"Washington National, DC", PHL:"Philadelphia, PA", BWI:"Baltimore, MD",
  CLT:"Charlotte, NC", RDU:"Raleigh-Durham, NC", MCO:"Orlando, FL", TPA:"Tampa, FL",
  MIA:"Miami, FL", FLL:"Fort Lauderdale, FL", RSW:"Fort Myers, FL", SRQ:"Sarasota, FL",
  PNS:"Pensacola, FL", VPS:"Destin/Ft Walton Beach, FL",
  MSP:"Minneapolis–St. Paul, MN", DTW:"Detroit, MI", CLE:"Cleveland, OH", CVG:"Cincinnati, OH",
  // Mexico / Caribbean
  CUN:"Cancún, MX", CZM:"Cozumel, MX", SJD:"San José del Cabo, MX", PVR:"Puerto Vallarta, MX",
  MEX:"Mexico City, MX", GDL:"Guadalajara, MX", PUJ:"Punta Cana, DO", MBJ:"Montego Bay, JM",
  NAS:"Nassau, BS", AUA:"Aruba, AW", SJU:"San Juan, PR", STT:"St. Thomas, VI", STX:"St. Croix, VI"
};

const AIRLINE_NAME = {
  AAL:"American", ENY:"Envoy", JIA:"PSA", RPA:"Republic",
  DAL:"Delta", EDV:"Endeavor", SKW:"SkyWest",
  UAL:"United", UCA:"CommuteAir",
  SWA:"Southwest", NKS:"Spirit", JBU:"JetBlue", FFT:"Frontier", ASA:"Alaska", AAY:"Allegiant"
};

// Simple, original SVG marks (not official logos) for readability.
const USE_MEDIA_KIT_LOGOS = false; // later: set true and add assets/logos/ for official marks

const AIRLINE_SVG = {
  AAL: `<svg viewBox="0 0 100 100" aria-label="American"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">AA</text></svg>`,
  DAL: `<svg viewBox="0 0 100 100" aria-label="Delta"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">DL</text></svg>`,
  UAL: `<svg viewBox="0 0 100 100" aria-label="United"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">UA</text></svg>`,
  SWA: `<svg viewBox="0 0 100 100" aria-label="Southwest"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">WN</text></svg>`,
  JBU: `<svg viewBox="0 0 100 100" aria-label="JetBlue"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">B6</text></svg>`,
  FFT: `<svg viewBox="0 0 100 100" aria-label="Frontier"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">F9</text></svg>`,
  NKS: `<svg viewBox="0 0 100 100" aria-label="Spirit"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">NK</text></svg>`,
  ASA: `<svg viewBox="0 0 100 100" aria-label="Alaska"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">AS</text></svg>`,
  AAY: `<svg viewBox="0 0 100 100" aria-label="Allegiant"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">G4</text></svg>`,
  ENY: `<svg viewBox="0 0 100 100" aria-label="Envoy"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">EN</text></svg>`,
  SKW: `<svg viewBox="0 0 100 100" aria-label="SkyWest"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">OO</text></svg>`
};

// Rough aircraft family hints by common operator (best-effort only)
const AIRLINE_FLEET_HINT = {
  SWA:"B737-family", AAL:"A320/B737 mix", DAL:"A320/B737 mix", UAL:"A320/B737 mix",
  ENY:"E175/CRJ", JIA:"CRJ", RPA:"E175/ERJ", SKW:"E175/CRJ", EDV:"CRJ"
};

// ADSBDB lookups can be rate limited; we do ONE lookup per 30s max and back off on 429.
let adsbCache = new Map(); // callsign -> {ts,data}
let adsbNextAllowedTs = 0;
let adsbBackoffUntil = 0;

function airportLabel(code){
  if (!code) return "—";
  const c = String(code).toUpperCase();
  const city = AIRPORT_CITY[c];
  return city ? `${c} (${city})` : c;
}

function airlineCodeFromCallsign(cs){
  if (!cs) return "";
  const s = cs.trim().toUpperCase();
  const m = s.match(/^([A-Z]{2,3})\d/);
  return m ? m[1] : "";
}

function operatorBrandSVG(cs){
  const code = airlineCodeFromCallsign(cs) || "✈";
  const name = AIRLINE_NAME[code] || code;
  return `<svg viewBox="0 0 100 100" aria-label="${name}">
    <rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/>
    <text x="50" y="56" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">${code.slice(0,3)}</text>
    <text x="50" y="78" text-anchor="middle" font-size="12" font-weight="800" fill="currentColor">${name.replace(/&/g,"and").slice(0,14)}</text>
  </svg>`;
}

function logoSVGFromCallsign(cs){
  const code = airlineCodeFromCallsign(cs);
  if (code && AIRLINE_SVG[code]) return AIRLINE_SVG[code];
  const label = code || "✈";
  return `<svg viewBox="0 0 100 100" aria-label="${label}"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/><text x="50" y="60" text-anchor="middle" font-size="34" font-weight="950" fill="currentColor">${label}</text></svg>`;
}

function logoTextFromCallsign(cs){
  const code = airlineCodeFromCallsign(cs);
  return code || "✈";
}

function modelHintFromCallsign(cs){
  const code = airlineCodeFromCallsign(cs);
  if (!code) return "—";
  const name = AIRLINE_NAME[code] || code;
  const hint = AIRLINE_FLEET_HINT[code] ? ` • ${AIRLINE_FLEET_HINT[code]}` : "";
  return `${name}${hint}`;
}

async function fetchAdsbdbForCallsign(callsign){
  const now = Date.now();
  const key = (callsign||"").trim().toUpperCase();
  if (!key) return null;

  // cache 10 minutes
  const cached = adsbCache.get(key);
  if (cached && (now - cached.ts) < 10*60*1000) return cached.data;

  if (now < adsbBackoffUntil) return null;
  if (now < adsbNextAllowedTs) return null;

  adsbNextAllowedTs = now + 30*1000; // one call per 30s

  const url = `${PROXY}adsb/${encodeURIComponent(key)}`;

  try{
    const res = await fetchWithTimeout(url, 6500);
    if (res.status === 429){
      adsbBackoffUntil = now + 5*60*1000;
      return null;
    }
    if (!res.ok) return null;
    const js = await res.json();
    adsbCache.set(key, {ts: now, data: js});
    return js;
  }catch(e){
    return null;
  }
}

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


function setText(id, value){
  const el = document.getElementById(id);
  const v = (value === undefined || value === null) ? "" : String(value);
  if (el && el.textContent !== v) el.textContent = v;
}

function setHTML(id, html){
  const el = document.getElementById(id);
  const h = (html === undefined || html === null) ? "" : String(html);
  if (el && el.innerHTML !== h) el.innerHTML = h;
}

function setClass(id, cls){
  const el = document.getElementById(id);
  if (!el) return;
  if (el.className !== cls) el.className = cls;
}

function setStatus(msg){
  const el = document.getElementById("fw-status");
  if (el && el.textContent !== msg) el.textContent = msg;
}

function homePlaceLabel(){
  const dToXNA = haversineMi(HOME_LAT, HOME_LON, XNA_FALLBACK.lat, XNA_FALLBACK.lon);
  if (dToXNA <= 60) return "Fayetteville/Bentonville, AR (XNA area)";
  return `${HOME_LAT.toFixed(3)}, ${HOME_LON.toFixed(3)}`;
}

function setHomeLine(){
  const el = document.getElementById("homeLine");
  if (!el) return;
  el.textContent = `HOME: ${homePlaceLabel()} • RANGE: ${RANGE_MI} MI`;
}
function setFade(){ /* disabled in v52 */ }
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
    if (t.textContent !== "NO TRAFFIC IN RANGE") t.textContent = "NO TRAFFIC IN RANGE";
    return;
  }
  const items = flights.slice(0,5).map(f => {
    const d = `${f.dist.toFixed(1)}MI`;
    const a = f.altFt ? `${Math.round(f.altFt/100)*100}FT` : "—";
    const s = f.spdMph ? `${Math.round(f.spdMph)}MPH` : "—";
    const code = airlineCodeFromCallsign(f.callsign);
    const name = AIRLINE_NAME[code] || code || "";
    return `${f.callsign || "—"}${name ? (' ('+name+')') : ''} • ${d} • ${a} • ${s}`;
  });
  const txt = items.join("   ✦   ") + "   ✦   " + items.join("   ✦   ");
  if (t.textContent !== txt) t.textContent = txt;
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
  const airlineNameEl = document.getElementById("airline-name");
  const logoEl = document.getElementById("logo");

  if (!current){
    setText("cs","—");
    setText("route","NO NEARBY FLIGHTS");
    setText("model","—");
    setText("alt","—");
    setText("spd","—");
    setText("dist","—");
    setText("dir","—");
    setText("meta","Adjust range or turn off commercial-only to see more traffic.");;
    setClass("badge","badge estimated");
    setText("badge","≈");
    if (logoEl){
      if (logoEl.getAttribute("data-airline") !== "") logoEl.setAttribute("data-airline","");
      setHTML("logo", operatorBrandSVG("")); 
    }
    return;
  }

  const code = airlineCodeFromCallsign(current.callsign);
  const airlineName = AIRLINE_NAME[code] || code || "—";
  if (airlineNameEl) setText("airline-name", airlineName);
  setText("cs",(current.callsign || "UNKNOWN"));
  if (logoEl){
    const code = airlineCodeFromCallsign(current.callsign) || "";
    if (logoEl.getAttribute("data-airline") !== code) logoEl.setAttribute("data-airline", code);
    setHTML("logo", operatorBrandSVG(current.callsign));
  }
  setText("model", modelHintFromCallsign(current.callsign));
  setText("route", current.routePretty || "—");
  // model is set from hints; a real model may overwrite it later

  setText("alt", current.altFt ? `${Math.round(current.altFt).toLocaleString()} FT` : "—");
  setText("spd", current.spdMph ? `${Math.round(current.spdMph)} MPH` : "—");
  setText("dist", `${current.dist.toFixed(1)} MI`);

  const b = bearing(HOME_LAT, HOME_LON, current.lat, current.lon);
  setText("dir", `${dirText(b)} ${Math.round(b)}°`);

  setText("meta", current.metaPretty || `COUNTRY: ${current.originCountry || "—"} • ICAO24: ${current.icao24 || "—"}`);

  setClass("badge","badge estimated");
  setText("badge","≈");
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
  if (current){ current.routePretty = null; current.metaPretty = null; }
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

    // Optional: enrich ONLY the displayed flight (route + exact model) with backoff-safe lookup
    if (current && current.callsign){
      const extra = await fetchAdsbdbForCallsign(current.callsign);
      if (extra && (extra.origin || extra.destination || extra.route)){
        const o = extra.origin?.iata || extra.origin?.icao || "";
        const d = extra.destination?.iata || extra.destination?.icao || "";
        if (o && d){
          const oLbl = airportLabel(o);
          const dLbl = airportLabel(d);
          current.routePretty = `${oLbl} → ${dLbl}`;
          const reg = extra.registration ? `REG: ${extra.registration} • ` : "";
          const mdl = extra.model ? `MODEL: ${extra.model}` : "";
          current.metaPretty = `SOURCE: ADSBDB • ${reg}${mdl}`.trim();
          if (extra.model) setText("model", extra.model);
          setClass("badge","badge verified");
          setText("badge","✓");
        }
      }
    }

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
  document.getElementById("fw-version").textContent = "v59";
  hookControls();
  detectLocation(); // doesn't block
  setStatus("SCANNING AIRSPACE…");
  render();
  tick();
  setInterval(tick, 3000);
  restartRotate();
}

document.addEventListener("DOMContentLoaded", start);
