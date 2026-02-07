// FlightWall UI (v170)
// Option A: Pages hosts this UI, Worker hosts API.
// Set API_BASE to your Worker domain. (No trailing slash)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v180";
const POLL_MS = 3500;

// Persist Aerodatabox + aircraft enrichments across refreshes.
// Keyed by icao24 + callsign to avoid "route flashes then disappears".
// Key: `${icao24}|${normalizedCallsign}`
const enrichCache = new Map();

const $ = (id) => document.getElementById(id);
const errBox = $("errBox");

function showErr(msg){
  const m = String(msg||"");
  if (/AbortError/i.test(m) || /fetch aborted/i.test(m) || /aborted/i.test(m)) return;
  try {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
  } catch {}
}
window.addEventListener("error", (e)=>showErr("JS error: " + (e?.message || e)));
window.addEventListener("unhandledrejection", (e)=>showErr("Promise rejection: " + (e?.reason?.message || e?.reason || e)));

function nm(s){ return (s ?? "").toString().trim(); }

function haversineMi(lat1, lon1, lat2, lon2){
  const R = 3958.7613;
  const toRad = (d)=>d*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function headingToText(deg){
  if (!Number.isFinite(deg)) return "—";
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  const idx = Math.round(((deg % 360) / 45)) % 8;
  const d = Math.round(deg);
  return `${dirs[idx]} (${d}°)`;
}

function fmtAlt(meters){
  if (!Number.isFinite(meters)) return "—";
  const ft = Math.round(meters * 3.28084);
  return `${ft.toLocaleString()} ft`;
}

function fmtSpd(mps){
  if (!Number.isFinite(mps)) return "—";
  const mph = Math.round(mps * 2.23694);
  return `${mph.toLocaleString()} mph`;
}

function fmtMi(mi){
  if (!Number.isFinite(mi)) return "—";
  return `${Math.round(mi)} mi`;
}

function setStatus(text){
  try { $("statusText").textContent = text; } catch {}
}

function normalizeCallsign(cs){
  return nm(cs).replace(/\s+/g,"").toUpperCase();
}

function setLogo(code){
  const img = $("airlineLogo");
  if (!img) return;

  const safe = nm(code).toUpperCase();
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

  $("callsign").textContent = nm(f.callsign) || "—";
  $("route").textContent = nm(f.route) || "—";
  $("model").textContent = nm(f.model) || "—";
  $("icao24").textContent = nm(f.icao24) ? nm(f.icao24).toLowerCase() : "—";

  // Airline name centered at top (no label)
  $("airline").textContent = nm(f.airlineName) || "Unknown Airline";

  // Logo uses mapped ICAO/IATA when available
  setLogo(f.airlineIcao || f.airlineIata || "");

  $("alt").textContent = fmtAlt(f.baroAlt);
  $("spd").textContent = fmtSpd(f.velocity);
  $("dist").textContent = fmtMi(f.distanceMi);
  $("dir").textContent = headingToText(f.heading);

  $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;

  // ✅ REDO: Remove UI version, call API version 1.1
  $("debugLine").textContent = `API 1.1`;
}

function renderList(list){
  const el = $("list");
  el.innerHTML = "";
  list.forEach((f)=>{
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="left">
        <div class="cs">${f.callsign || "—"}</div>
        <div class="sub">${fmtMi(f.distanceMi)} • ${fmtAlt(f.baroAlt)} • ${fmtSpd(f.velocity)}</div>
      </div>
      <div class="badge">${f.icao24 || ""}</div>
    `;
    el.appendChild(row);
  });
}

// ----- Tier filtering -----
const TIER_A_PREFIXES = ["AAL","DAL","UAL","SWA","ASA","FFT","NKS","JBU","AAY"];
const TIER_B_EXTRA_PREFIXES = ["SKW","ENY","EDV","JIA","RPA","GJS","UPS","FDX"];
const TIER_ALL_PREFIXES = [...new Set([...TIER_A_PREFIXES, ...TIER_B_EXTRA_PREFIXES])];

function tierPrefixes(tier){
  return tier === "B" ? TIER_ALL_PREFIXES : TIER_A_PREFIXES;
}

function setTierUI(tier){
  const seg = $("tierSegment");
  if (!seg) return;
  seg.querySelectorAll("button").forEach((b)=>{
    b.classList.toggle("active", b.dataset.tier === tier);
  });
}

let currentTier = "A";

function setupTier(){
  const seg = $("tierSegment");
  if (!seg) return;
  seg.addEventListener("click", (e)=>{
    const btn = e.target.closest("button[data-tier]");
    if (!btn) return;
    currentTier = btn.dataset.tier;
    setTierUI(currentTier);
  });
}

async function fetchRadar(tier){
  const url = `${API_BASE}/radar?tier=${encodeURIComponent(tier || "A")}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Radar HTTP ${r.status}`);
  return await r.json();
}

function pickPrimary(list){
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0];
}

async function tick(){
  try{
    errBox.classList.add("hidden");
    errBox.textContent = "";

    const data = await fetchRadar(currentTier);
    const flights = Array.isArray(data.flights) ? data.flights : [];

    const radarMeta = {
      count: Number.isFinite(data.count) ? data.count : flights.length,
      showing: Number.isFinite(data.showing) ? data.showing : Math.min(flights.length, 5),
      apiVersion: data.apiVersion
    };

    // apply cache
    flights.forEach((f)=>{
      const key = `${nm(f.icao24)}|${normalizeCallsign(f.callsign)}`;
      const cached = enrichCache.get(key);
      if (cached) Object.assign(f, cached);
    });

    const primary = pickPrimary(flights);
    if (primary) renderPrimary(primary, radarMeta);

    renderList(flights.slice(0,5));
    setStatus("Live");
  } catch(err){
    setStatus("Error");
    showErr(err?.message || String(err));
  }
}

function boot(){
  setupTier();
  setTierUI(currentTier);
  tick();
  setInterval(tick, POLL_MS);
}

boot();