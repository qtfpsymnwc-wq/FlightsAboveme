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
window.addEventListener("error", (e) => {
  try { showErr(e?.message || "UI error"); } catch {}
});
window.addEventListener("unhandledrejection", (e) => {
  try { showErr(e?.reason?.message || e?.reason || "Promise rejected"); } catch {}
});

let aborter = null;

function fmtAlt(ft){
  if (!Number.isFinite(ft)) return "—";
  const n = Math.round(ft);
  return `${n.toLocaleString()} ft`;
}
function fmtKts(kts){
  if (!Number.isFinite(kts)) return "—";
  const n = Math.round(kts);
  return `${n} kt`;
}
function fmtMi(mi){
  if (!Number.isFinite(mi)) return "—";
  if (mi < 1) return `${mi.toFixed(2)} mi`;
  return `${mi.toFixed(1)} mi`;
}
function fmtDeg(deg){
  if (!Number.isFinite(deg)) return "—";
  const n = Math.round(deg);
  return `${n}°`;
}

function normalizeCallsign(cs){
  return (cs || "").toString().trim().toUpperCase().replace(/\s+/g,"");
}

function safeText(v){
  const s = (v == null) ? "" : String(v);
  return s;
}

// Airline grouping / tiering
// A: Airlines (commercial passenger only)
// B: Other (private, cargo, mil/gov, unknown)
const CARGO_PREFIXES = new Set([
  "FDX","UPS","ABX","GTI","CKS","CLX","PAC","GEC","KAL","KFS","CVG","BOX","TAY","SRR","NCR","AJT","MPE","RZZ"
]);

const MIL_PREFIXES = new Set([
  "RCH","MOOSE","HUNTER","PAT","QID","HERKY","DUKE","BAF","NATO","BLUE","NAVY","AF","ARMY","USAF","USN"
]);

const PRIVATE_PREFIXES = new Set([
  "N","EJA","XOJ","DCM","PJC","JTL","GAJ","VJT","VXP","LXJ","HRT","GSJ","NJE","FJE","KFB","PBR"
]);

// Allowlist of passenger airline callsign prefixes for Tier A
// This is intentionally conservative to avoid misclassifying private/cargo as airlines.
const PASSENGER_PREFIXES = new Set([
  "AAL","DAL","UAL","SWA","ASA","JBU","FFT","NKS","AAY","SCX","HAL","MXY",
  "SKW","RPA","JIA","ENY","EDV","PDT","AWI","ASH","QXE","GJS"
]);

function airlineKeyFromCallsign(callsign){
  const cs = normalizeCallsign(callsign);
  if (!cs) return null;

  // Tail numbers (US)
  if (/^N[0-9A-Z]+/.test(cs)) return null;

  // Explicit prefixes
  const m = cs.match(/^([A-Z]{3})/);
  return m ? m[1] : null;
}

function logoUrlForCallsign(callsign, ext="png"){
  const key = airlineKeyFromCallsign(callsign);
  const k = (key || "").toString().trim().toUpperCase();
  const file = k ? `${k}.${ext}` : `_GENERIC.${ext}`;
  // cache-bust per UI version
  return `/assets/logos/${file}?v=${encodeURIComponent(UI_VERSION)}`;
}

// Resolve a logo key (typically ICAO, e.g. "AAL") into a static asset URL.
function logoUrlForKey(key, ext="png"){
  const k = (key || "").toString().trim().toUpperCase();
  const file = k ? `${k}.${ext}` : `_GENERIC.${ext}`;
  return `/assets/logos/${file}?v=${encodeURIComponent(UI_VERSION)}`;
}

function logoUrlForFlight(f){
  const key =
    (f?.airlineIcao || f?.operatorIcao || airlineKeyFromCallsign(f?.callsign || "")) ||
    airlineKeyFromCallsign(f?.callsign || "");
  return logoUrlForKey(key, "png");
}

function classifyTier(f){
  const cs = normalizeCallsign(f?.callsign);
  if (!cs) return "B";
  if (/^N[0-9A-Z]+/.test(cs)) return "B";

  const pref = airlineKeyFromCallsign(cs);
  if (!pref) return "B";

  if (CARGO_PREFIXES.has(pref)) return "B";
  if (MIL_PREFIXES.has(pref)) return "B";
  if (PRIVATE_PREFIXES.has(pref)) return "B";

  if (PASSENGER_PREFIXES.has(pref)) return "A";

  // If AeroDataBox metadata says it's a passenger airline (via airlineIcao), allow it.
  // But do not guess for cargo/private.
  if (f?.airlineIcao && String(f.airlineIcao).trim().length === 3) return "A";

  return "B";
}

function pickClosest(list){
  if (!Array.isArray(list) || list.length === 0) return null;
  // Prefer nearest with distance, else first
  const withDist = list.filter(x => Number.isFinite(x?.distanceMi));
  if (withDist.length === 0) return list[0];
  withDist.sort((a,b) => (a.distanceMi - b.distanceMi));
  return withDist[0];
}

function renderPrimary(f){
  if (!f) return;

  const cs = normalizeCallsign(f.callsign);
  const tier = classifyTier(f);

  const inferredAirline =
    (tier === "A"
      ? (f.airlineName || f.operatorName || "")
      : (f.operatorName || f.airlineName || ""))
    || "";

  const countryFallback =
    (f.country && f.country !== "United States") ? f.country : "—";

  $("callsign").textContent = cs || "—";
  $("airline").textContent = inferredAirline || countryFallback;

  // Airline logo (stored as static assets in Pages)
  try {
    const img = $("airlineLogo");
    if (img) {
      img.dataset.fallbackStage = "png";
      img.onerror = () => {
        const stage = img.dataset.fallbackStage || "png";
        if (stage === "png") {
          // If PNG is missing, try SVG with the same key.
          img.dataset.fallbackStage = "svg";
          const key2 = (f.airlineIcao || f.operatorIcao || airlineKeyFromCallsign(f.callsign || "")) || "";
          img.src = logoUrlForKey(key2, "svg");
          return;
        }
        if (stage === "svg") {
          // Final fallback: generic SVG
          img.dataset.fallbackStage = "done";
          img.src = logoUrlForKey("", "svg");
          return;
        }
      };

      img.src = logoUrlForFlight(f);
      img.classList.remove("hidden");
      const key = (f.airlineIcao || f.operatorIcao || airlineKeyFromCallsign(f.callsign || "")) || "";
      img.alt = key ? `${key} logo` : "Airline logo";
    }
  } catch (_) {}

  $("alt").textContent = fmtAlt(f.altitudeFt);
  $("spd").textContent = fmtKts(f.velocityKts);
  $("dist").textContent = fmtMi(f.distanceMi);
  $("dir").textContent = fmtDeg(f.headingDeg);

  $("origin").textContent = safeText(f?.origin?.iata || f?.origin?.icao || "—");
  $("dest").textContent = safeText(f?.destination?.iata || f?.destination?.icao || "—");

  const icao24 = (f.icao24 || "—").toString().toUpperCase();
  $("icao24").textContent = icao24;

  const ac = f.aircraft || null;
  $("aircraftType").textContent = safeText(ac?.typeName || ac?.model || ac?.modelCode || ac?.icaoCode || "—");
}

function renderList(list){
  const wrap = $("list");
  wrap.innerHTML = "";

  const top = Array.isArray(list) ? list.slice(0,5) : [];
  for (const f of top){
    const row = document.createElement("div");
    row.className = "row";

    const left = document.createElement("div");
    left.className = "l";

    const cs = document.createElement("div");
    cs.className = "cs";
    cs.textContent = normalizeCallsign(f.callsign) || "—";

    const rt = document.createElement("div");
    rt.className = "rt";
    rt.textContent = safeText(f?.route || "—");

    const mo = document.createElement("div");
    mo.className = "m";
    mo.textContent = safeText(f?.aircraft?.typeName || f?.aircraft?.model || f?.aircraft?.modelCode || f?.aircraft?.icaoCode || "—");

    left.appendChild(cs);
    left.appendChild(rt);
    left.appendChild(mo);

    const right = document.createElement("div");
    right.className = "r";

    const d = document.createElement("div");
    d.className = "d";
    d.textContent = fmtMi(f.distanceMi);

    const a = document.createElement("div");
    a.className = "a";
    a.textContent = fmtAlt(f.altitudeFt);

    right.appendChild(d);
    right.appendChild(a);

    row.appendChild(left);
    row.appendChild(right);

    row.addEventListener("click", () => {
      renderPrimary(f);
      window.scrollTo({top:0, behavior:"smooth"});
    });

    wrap.appendChild(row);
  }
}

async function apiHealth(){
  const url = `${API_BASE}/health`;
  const r = await fetch(url, { cache:"no-store" });
  if (!r.ok) throw new Error(`Health ${r.status}`);
  return r.json();
}

async function apiStates(){
  const url = `${API_BASE}/opensky/states`;
  const r = await fetch(url, { cache:"no-store" });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`States ${r.status} ${t}`.trim());
  }
  return r.json();
}

function mergeEnrich(f){
  const cs = normalizeCallsign(f.callsign);
  const key = `${(f.icao24||"").toString().toUpperCase()}|${cs}`;
  const cached = enrichCache.get(key);
  if (cached){
    return {
      ...f,
      airlineName: f.airlineName || cached.airlineName,
      airlineIcao: f.airlineIcao || cached.airlineIcao,
      operatorName: f.operatorName || cached.operatorName,
      operatorIcao: f.operatorIcao || cached.operatorIcao,
      route: f.route || cached.route,
      radar: f.radar || cached.radar,
      aircraft: f.aircraft || cached.aircraft,
      origin: f.origin || cached.origin,
      destination: f.destination || cached.destination,
      country: f.country || cached.country
    };
  }
  const hasEnrich =
    (f.airlineName || f.airlineIcao || f.operatorName || f.operatorIcao || f.route || f.radar ||
     (f.aircraft && Object.keys(f.aircraft).length > 0) ||
     f.origin || f.destination);
  if (hasEnrich){
    enrichCache.set(key, f);
  }
  return f;
}

function filterTier(list, tier, showMil){
  if (!Array.isArray(list)) return [];
  return list.filter(f => {
    const t = classifyTier(f);
    if (t !== tier) return false;
    // keep the baseline "showMil" behavior: if showMil is false, hide mil prefixes
    if (!showMil){
      const pref = airlineKeyFromCallsign(f?.callsign || "");
      if (pref && MIL_PREFIXES.has(pref)) return false;
    }
    return true;
  });
}

function setStatus(text){
  const el = $("statusText");
  if (!el) return;
  el.textContent = text;
}

async function tick(force){
  if (aborter) aborter.abort();
  aborter = new AbortController();

  try {
    errBox.classList.add("hidden");

    const data = await apiStates();
    const flights = (data && Array.isArray(data.flights)) ? data.flights.map(mergeEnrich) : [];

    const tiered = filterTier(flights, tier, showMil);

    const closest = pickClosest(tiered);
    if (closest) renderPrimary(closest);

    renderList(tiered);

    const n = tiered.length;
    setStatus(n ? `Showing ${Math.min(n,5)} of ${n}` : "No flights in this category right now");
  } catch (e){
    showErr(e?.message || String(e));
    setStatus("Error");
  } finally {
    setTimeout(() => tick(false), POLL_MS);
  }
}

async function init(){
  $("statusText").textContent = "Locating…";

  // UI controls
  const tierSegment = document.getElementById("tierSegment");
  const showMilEl = document.getElementById("showMil");

  // Group info modal
  const groupInfoBtn = document.getElementById("groupInfoBtn");
  const groupInfo = document.getElementById("groupInfo");
  const groupInfoOk = document.getElementById("groupInfoOk");
  const groupInfoClose = document.getElementById("groupInfoClose");

  const openGroupInfo = ()=>{ if (groupInfo) groupInfo.hidden = false; };
  const closeGroupInfo = ()=>{ if (groupInfo) groupInfo.hidden = true; };

  if (groupInfoBtn) groupInfoBtn.addEventListener("click", openGroupInfo);
  if (groupInfoOk) groupInfoOk.addEventListener("click", closeGroupInfo);
  if (groupInfoClose) groupInfoClose.addEventListener("click", closeGroupInfo);

  // Tier + options (baseline behavior)
  let tier = (localStorage.getItem("fw_tier") || "A").toUpperCase();
  if (tier !== "A" && tier !== "B") tier = "A";

  let showMil = localStorage.getItem("fw_showMil") === "1";

  function syncTierButtons(){
    if (!tierSegment) return;
    [...tierSegment.querySelectorAll("button[data-tier]")].forEach((b)=>{
      const t = (b.getAttribute("data-tier") || "A").toUpperCase();
      b.classList.toggle("active", t === tier);
    });
  }

  if (tierSegment) {
    tierSegment.addEventListener("click", (e)=>{
      const btn = e.target && e.target.closest ? e.target.closest("button[data-tier]") : null;
      if (!btn) return;
      tier = (btn.getAttribute("data-tier") || "A").toUpperCase();
      if (tier !== "A" && tier !== "B") tier = "A";
      localStorage.setItem("fw_tier", tier);
      syncTierButtons();
      tick(true);
    });
    syncTierButtons();
  }

  if (showMilEl) {
    showMilEl.checked = showMil;
    showMilEl.addEventListener("change", ()=>{
      showMil = !!showMilEl.checked;
      localStorage.setItem("fw_showMil", showMil ? "1" : "0");
      tick(true);
    });
  }

  // Health / version info (not shown in UI)
  try { await apiHealth(); } catch {}

  // Start polling
  tick(true);
}

document.addEventListener("DOMContentLoaded", init);