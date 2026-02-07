// FlightWall UI (v180)
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";
const UI_VERSION = "v180";
const POLL_MS = 3500;

const enrichCache = new Map();

const $ = (id) => document.getElementById(id);
const errBox = $("errBox");

function showErr(msg) {
  const m = String(msg || "");
  if (/AbortError|aborted/gi.test(m)) return;
  try {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
  } catch {}
}

window.addEventListener("error", (e) => showErr("JS error: " + e.message));
window.addEventListener("unhandledrejection", (e) => showErr("Promise rejection: " + (e.reason?.message || e.reason)));

function nm(s) { return (s ?? "").toString().trim(); }

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.7613, toRad = d => d * Math.PI/180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function headingToText(deg) {
  if (!Number.isFinite(deg)) return "—";
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  const idx = Math.round((((deg%360)+360)%360) / 45) % 8;
  return `${dirs[idx]} (${Math.round(deg)}°)`;
}

function fmtAlt(m) { return Number.isFinite(m) ? Math.round(m * 3.28084).toLocaleString() + " ft" : "—"; }
function fmtSpd(ms) { return Number.isFinite(ms) ? Math.round(ms * 2.236936) + " mph" : "—"; }
function fmtMi(mi) { return Number.isFinite(mi) ? mi.toFixed(mi < 10 ? 1 : 0) + " mi" : "—"; }

// Tier filtering
const TIER_A_PREFIXES = ["AAL","DAL","UAL","SWA","ASA","FFT","NKS","JBU","AAY"];
const TIER_B_EXTRA_PREFIXES = ["SKW","ENY","EDV","JIA","RPA","GJS","UPS","FDX"];
const TIER_ALL_PREFIXES = [...new Set([...TIER_A_PREFIXES, ...TIER_B_EXTRA_PREFIXES])];

function callsignPrefix(cs) {
  const s = nm(cs).replace(/\s+/g, "").toUpperCase();
  const m = s.match(/^[A-Z]{3}/);
  return m ? m[0] : s.slice(0,3);
}

function groupForFlight(cs) {
  const p = callsignPrefix(cs);
  if (!p) return "B";
  return TIER_ALL_PREFIXES.includes(p) ? "A" : "B";
}

function logoUrlForKey(key) {
  const file = key ? `${key.toUpperCase()}.svg` : `_GENERIC.svg`;
  return `/assets/logos/${file}?v=${encodeURIComponent(UI_VERSION)}`;
}

function logoUrlForFlight(f) {
  const key = (f.airlineIcao || f.operatorIcao || callsignPrefix(f.callsign)).toUpperCase();
  return logoUrlForKey(key);
}

function bboxAround(lat, lon) {
  const dLat = 0.6, dLon = 0.8;
  return {
    lamin: (lat - dLat).toFixed(4),
    lamax: (lat + dLat).toFixed(4),
    lomin: (lon - dLon).toFixed(4),
    lomax: (lon + dLon).toFixed(4),
  };
}

async function fetchJSON(url, timeoutMs=8000) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function enrichRoute(primary) {
  const cs = nm(primary.callsign).toUpperCase();
  if (!cs) return;
  try {
    const data = await fetchJSON(`${API_BASE}/flight/${encodeURIComponent(cs)}`,9000);
    if (data?.ok) primary.routeText = data.route || primary.routeText;
  } catch {}
}

async function enrichAircraft(primary) {
  const hex = nm(primary.icao24).toLowerCase();
  if (!hex) return;
  try {
    const data = await fetchJSON(`${API_BASE}/aircraft/icao24/${encodeURIComponent(hex)}`,9000);
    if (data?.ok && data.found) {
      const mfg = nm(data.manufacturer), mdl = nm(data.model), code = nm(data.modelCode);
      primary.modelText = `${mfg||""} ${mdl||""}${code && code!==mdl?` (${code})`: ""}`.trim();
    }
  } catch {}
}

function renderPrimary(f, radarMeta) {
  $("callsign").textContent = f.callsign || "—";
  $("icao24").textContent = f.icao24 || "—";
  $("airline").textContent = f.airlineName || f.airlineGuess || "—";
  $("route").textContent = f.routeText || "—";
  $("model").textContent = f.modelText || "—";

  $("alt").textContent = fmtAlt(f.baroAlt);
  $("spd").textContent = fmtSpd(f.velocity);
  $("dist").textContent = fmtMi(f.distanceMi);
  $("dir").textContent = headingToText(f.trueTrack);

  $("radarLine").textContent = `Radar: ${radarMeta.count} flights • Showing: ${radarMeta.showing}`;
  $("debugLine").textContent = `UI ${UI_VERSION} • API ${radarMeta.apiVersion||"?"}`;

  const img = $("airlineLogo");
  if (img) {
    img.onerror = () => { img.src = logoUrlForKey(""); };
    img.src = logoUrlForFlight(f);
    img.classList.remove("hidden");
  }
}

function renderList(list) {
  const el = $("list");
  el.innerHTML = "";
  list.forEach(f => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="left">
        <div class="cs">${f.callsign||"—"}</div>
        <div class="sub">${fmtMi(f.distanceMi)} • ${fmtAlt(f.baroAlt)} • ${fmtSpd(f.velocity)}</div>
      </div>
      <div class="badge">${f.icao24||""}</div>
    `;
    el.appendChild(row);
  });
}

async function main() {
  $("statusText").textContent = "Locating…";

  let tier = (localStorage.getItem("fw_tier") || "A").toUpperCase();
  const tierSegment = $("tierSegment");

  if (tierSegment) {
    tierSegment.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tier]");
      if (!btn) return;
      tier = btn.getAttribute("data-tier").toUpperCase();
      localStorage.setItem("fw_tier", tier);
      [...tierSegment.querySelectorAll("button[data-tier]")].forEach(b =>
        b.classList.toggle("active", b.getAttribute("data-tier") === tier)
      );
    });
  }

  const pos = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy:true, timeout:12000
    });
  });

  const lat = pos.coords.latitude, lon = pos.coords.longitude;
  const bb = bboxAround(lat, lon);

  $("statusText").textContent = "Radar…";

  let apiVersion = "?";
  try { const h = await fetchJSON(`${API_BASE}/health`,6000); apiVersion = h.version||"?"; } catch {}

  async function tick() {
    try {
      const url = new URL(`${API_BASE}/opensky/states`);
      Object.entries(bb).forEach(([k,v]) => url.searchParams.set(k,v));

      const data = await fetchJSON(url.toString());
      const states = Array.isArray(data.states) ? data.states : [];

      const flights = states.map(s => {
        return {
          icao24: nm(s[0]).toLowerCase(),
          callsign: nm(s[1]),
          country: nm(s[2]),
          lon: s[5], lat: s[6],
          baroAlt: s[7], velocity: s[9], trueTrack: s[10],
          routeText: undefined, modelText: undefined, airlineGuess: guessAirline(nm(s[1]))
        };
      }).filter(f => Number.isFinite(f.distanceMi = (f.lat && f.lon) ? haversineMi(lat,lon,f.lat,f.lon) : Infinity))
        .sort((a,b)=>a.distanceMi-b.distanceMi);

      const shown = flights.filter(f=>groupForFlight(f.callsign)===tier);
      const primary = shown[0]||flights[0];
      const top5 = shown.slice(0,5);

      if (!primary) { $("statusText").textContent="No flights"; return; }

      for (const f of top5) {
        const key = `${f.icao24}|${nm(f.callsign).toUpperCase()}`;
        const cached = enrichCache.get(key);
        if (cached) Object.assign(f, cached);
      }

      $("statusText").textContent = "Live";
      renderPrimary(primary,{count:flights.length,showing:top5.length,apiVersion});
      renderList(top5);

      for (const f of top5) {
        const key = `${f.icao24}|${nm(f.callsign).toUpperCase()}`;
        await enrichRoute(f);
        await enrichAircraft(f);
        enrichCache.set(key,{routeText:f.routeText,airlineName:f.airlineName,modelText:f.modelText});
      }

    } catch(e) {
      showErr(e.message||e);
      $("statusText").textContent = "Radar error";
    }
  }

  tick();
  setInterval(tick, POLL_MS);
}

main();
