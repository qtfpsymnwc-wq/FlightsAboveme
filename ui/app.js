// FlightWall Baseline (boots on iOS even if radar fails)
// Change this to your Worker domain (no trailing slash):
const API_BASE = "https://flightsabove.t2hkmhgbwz.workers.dev";

// Polling
const POLL_MS = 3500;
const MAX_CARDS = 40;

// Local storage keys
const LS_KEY = "flightwall_cache_v1";
const LS_PREF = "flightwall_prefs_v1";

const el = (id) => document.getElementById(id);

const state = {
  filterMode: "airlines",      // "airlines" | "other" | "all"
  tiers: { t1: true, t2: true, t3: true },
  search: "",
  cache: {}, // keyed by `${icao24}|${callsign}`
  lastFetchMs: 0,
  lastCount: 0
};

// ---------- SAFETY: ensure guessAirline exists ----------
function guessAirline(f) {
  if (!f) return null;

  const name = (f.airlineName || f.airline || f.operator || "").toString().trim();
  const icao = (f.airlineIcao || f.icaoAirline || f.operatorIcao || "").toString().trim();
  const iata = (f.airlineIata || f.iataAirline || "").toString().trim();

  if (name) return { type: "airline", label: name, code: icao || iata || null };

  const cs = (f.callsign || f.callSign || "").toString().trim().toUpperCase();
  const prefix = cs.replace(/[^A-Z].*$/, "");

  if (prefix && prefix.length >= 2) {
    const map = {
      SWA: "Southwest",
      DAL: "Delta",
      UAL: "United",
      AAL: "American",
      ASA: "Alaska",
      JBU: "JetBlue",
      FFT: "Frontier",
      NKS: "Spirit",
      UPS: "UPS",
      FDX: "FedEx"
    };
    if (map[prefix]) return { type: "airline", label: map[prefix], code: prefix };
    return { type: "unknown", label: prefix, code: prefix };
  }

  return null;
}

// ---------- classification ----------
function isAirlineLike(f) {
  // Prefer explicit hints if present
  if (typeof f.isAirline === "boolean") return f.isAirline;

  const g = guessAirline(f);
  // If we can map a known airline prefix or have airlineName, treat as airline
  if (g && (g.type === "airline")) return true;

  // Registrations like N123AB are common for GA/private; callsigns with letters+digits can be either.
  // If callsign starts with N and then digits, that's usually US GA.
  const cs = (f.callsign || f.callSign || "").toString().trim().toUpperCase();
  if (/^N[0-9]/.test(cs)) return false;

  // If you have operator/airline fields, treat as airline-ish
  if ((f.airlineName || f.operator || f.airline) && !/^N[0-9]/.test(cs)) return true;

  return false;
}

function computeTier(f) {
  // Baseline tier logic:
  // T1 = has good aircraft/type info + altitude & speed
  // T2 = has partial info
  // T3 = minimal info
  const type = (f.typeName || f.aircraftType || f.model || f.icaoType || "").toString().trim();
  const alt = num(f.altitude || f.geoAlt || f.baroAlt);
  const spd = num(f.velocity || f.speed || f.groundSpeed);

  const hasType = !!type;
  const hasKinematics = isFinite(alt) || isFinite(spd);

  if (hasType && hasKinematics) return 1;
  if (hasType || hasKinematics) return 2;
  return 3;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

// ---------- UI ----------
function setStatus(kind, text) {
  el("statusText").textContent = text;
  const dot = el("statusDot");
  dot.classList.remove("good", "warn", "bad");
  if (kind) dot.classList.add(kind);
}

function setSegActive(btnIds, activeId) {
  for (const id of btnIds) el(id).classList.toggle("active", id === activeId);
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_PREF) || "{}");
    if (p.filterMode) state.filterMode = p.filterMode;
    if (p.tiers) state.tiers = { ...state.tiers, ...p.tiers };
    if (typeof p.search === "string") state.search = p.search;
  } catch {}
}

function savePrefs() {
  localStorage.setItem(LS_PREF, JSON.stringify({
    filterMode: state.filterMode,
    tiers: state.tiers,
    search: state.search
  }));
}

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    if (c && typeof c === "object") state.cache = c;
  } catch {}
}

function saveCache() {
  localStorage.setItem(LS_KEY, JSON.stringify(state.cache));
}

function clearCache() {
  state.cache = {};
  localStorage.removeItem(LS_KEY);
  render();
}

function formatFeet(metersOrFeet) {
  const n = num(metersOrFeet);
  if (!Number.isFinite(n)) return "—";
  // If values look like meters (typical baroAlt/geoAlt), convert to feet.
  // Heuristic: if under 2000, it's likely meters at low altitude. If around 10000+, could already be feet.
  const feet = (n < 2000) ? (n * 3.28084) : n;
  return `${Math.round(feet).toLocaleString()} ft`;
}

function formatKnots(mpsOrKnots) {
  const n = num(mpsOrKnots);
  if (!Number.isFinite(n)) return "—";
  // Heuristic: if under ~250, could be knots already or m/s. If under 200, assume m/s? Not reliable.
  // We'll treat < 200 as m/s and convert; >= 200 assume knots.
  const kts = (n < 200) ? (n * 1.94384) : n;
  return `${Math.round(kts)} kt`;
}

function normalizeFlight(raw) {
  const f = raw || {};
  const callsign = (f.callsign || f.callSign || "").toString().trim().toUpperCase();
  const icao24 = (f.icao24 || f.hex || f.hexIcao || "").toString().trim().toUpperCase();
  const reg = (f.registration || f.reg || "").toString().trim().toUpperCase();

  const typeName = (f.typeName || f.aircraftType || f.model || f.icaoType || "").toString().trim();
  const airlineGuess = guessAirline(f);

  const tier = computeTier(f);

  return {
    _raw: f,
    callsign,
    icao24,
    reg,
    typeName,
    airlineName: (f.airlineName || f.airline || f.operator || (airlineGuess && airlineGuess.label) || "").toString().trim(),
    altitude: f.altitude ?? f.geoAlt ?? f.baroAlt,
    speed: f.velocity ?? f.speed ?? f.groundSpeed,
    heading: f.heading ?? f.track,
    lat: f.lat ?? f.latitude,
    lon: f.lon ?? f.longitude,
    isAirline: isAirlineLike(f),
    tier
  };
}

function flightKey(f) {
  return `${f.icao24 || "??"}|${f.callsign || "??"}`;
}

function matchesSearch(f) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;

  const hay = [
    f.callsign, f.icao24, f.reg, f.typeName, f.airlineName
  ].join(" ").toLowerCase();

  return hay.includes(q);
}

function passesFilters(f) {
  // Filter mode
  if (state.filterMode === "airlines" && !f.isAirline) return false;
  if (state.filterMode === "other" && f.isAirline) return false;

  // Tier toggles
  if (f.tier === 1 && !state.tiers.t1) return false;
  if (f.tier === 2 && !state.tiers.t2) return false;
  if (f.tier === 3 && !state.tiers.t3) return false;

  // Search
  if (!matchesSearch(f)) return false;

  return true;
}

function renderCard(f) {
  const tierText = `T${f.tier}`;
  const airlineLine = f.airlineName ? f.airlineName : (f.isAirline ? "Airline" : "Other");

  const badges = [];
  if (f.typeName) badges.push(`<span class="badge">${escapeHtml(f.typeName)}</span>`);
  if (f.reg) badges.push(`<span class="badge mono">${escapeHtml(f.reg)}</span>`);
  if (f.icao24) badges.push(`<span class="badge mono">${escapeHtml(f.icao24)}</span>`);

  const alt = formatFeet(f.altitude);
  const spd = formatKnots(f.speed);
  const hdg = Number.isFinite(num(f.heading)) ? `${Math.round(num(f.heading))}°` : "—";

  const lat = Number.isFinite(num(f.lat)) ? num(f.lat).toFixed(3) : "—";
  const lon = Number.isFinite(num(f.lon)) ? num(f.lon).toFixed(3) : "—";

  return `
    <div class="card">
      <div class="tierTag">${tierText}</div>

      <div class="card-top">
        <div>
          <div class="callsign">${escapeHtml(f.callsign || "UNKNOWN")}</div>
          <div class="airline">${escapeHtml(airlineLine)}</div>
        </div>
        <div class="badges">
          ${badges.join("")}
        </div>
      </div>

      <div class="row">
        <div class="kv">
          <div class="k">Altitude</div>
          <div class="v">${alt}</div>
        </div>
        <div class="kv">
          <div class="k">Speed</div>
          <div class="v">${spd}</div>
        </div>
        <div class="kv">
          <div class="k">Heading</div>
          <div class="v">${hdg}</div>
        </div>
        <div class="kv">
          <div class="k">Position</div>
          <div class="v"><span class="mono">${lat}, ${lon}</span></div>
        </div>
      </div>

      <div class="small">
        <span>Mode: <b>${f.isAirline ? "Airline" : "Other"}</b></span>
      </div>
    </div>
  `;
}

function render() {
  const list = Object.values(state.cache)
    .map(normalizeFlight)
    .filter(passesFilters)
    .slice(0, MAX_CARDS);

  el("cards").innerHTML = list.map(renderCard).join("");

  el("metaText").textContent =
    `Showing ${list.length} • Cached ${Object.keys(state.cache).length} • Poll ${POLL_MS}ms`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ---------- data fetch ----------
async function fetchFlights() {
  setStatus("warn", "Loading…");

  try {
    const res = await fetch(`${API_BASE}/flights`, { cache: "no-store" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Flights HTTP ${res.status} ${res.statusText} :: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();

    // Accept either { flights: [...] } or [...]
    const flights = Array.isArray(data) ? data : (Array.isArray(data.flights) ? data.flights : []);

    // Merge into cache
    let added = 0;
    for (const raw of flights) {
      const n = normalizeFlight(raw);
      const key = flightKey(n);
      if (!state.cache[key]) added++;
      state.cache[key] = raw; // store raw, normalize on render
    }

    state.lastFetchMs = Date.now();
    state.lastCount = flights.length;
    saveCache();

    setStatus("good", `OK • ${flights.length} flights`);
    render();
  } catch (err) {
    console.error("[FLIGHTS] fetch failed:", err);
    setStatus("bad", "Fetch error");
    // keep whatever was cached; still render
    render();
  }
}

// ---------- radar (optional) ----------
async function safeLoadRadar() {
  const img = el("radarImg");
  const fb = el("radarFallback");
  const rs = el("radarStatus");

  fb.classList.remove("show");
  rs.textContent = "Loading…";

  try {
    // Supports either:
    // 1) API returns JSON: { imageUrl: "https://..." } (recommended)
    // 2) API returns an image directly at /radar.png (we’ll try as fallback)
    const res = await fetch(`${API_BASE}/radar`, { cache: "no-store" });

    if (res.ok) {
      const ct = (res.headers.get("content-type") || "").toLowerCase();

      if (ct.includes("application/json")) {
        const data = await res.json();
        const imageUrl = data.imageUrl || data.url || "";
        if (!imageUrl) throw new Error("Radar JSON missing imageUrl");
        img.src = imageUrl;
        rs.textContent = "OK";
        return;
      }

      // If endpoint returns an image directly
      if (ct.includes("image/")) {
        // Create blob URL
        const blob = await res.blob();
        img.src = URL.createObjectURL(blob);
        rs.textContent = "OK";
        return;
      }

      // If HTML/text came back, that’s an upstream error
      const txt = await res.text().catch(() => "");
      throw new Error(`Radar unexpected content-type ${ct} :: ${txt.slice(0, 200)}`);
    }

    // If /radar doesn't exist, try /radar.png
    const res2 = await fetch(`${API_BASE}/radar.png`, { cache: "no-store" });
    if (!res2.ok) throw new Error(`Radar HTTP ${res2.status} ${res2.statusText}`);

    const blob2 = await res2.blob();
    img.src = URL.createObjectURL(blob2);
    rs.textContent = "OK";
  } catch (err) {
    console.error("[RADAR] Failed:", err);
    rs.textContent = "Unavailable";
    fb.classList.add("show");
    // do NOT throw — app must keep running
  }
}

// ---------- wiring ----------
function wireUI() {
  // Filter mode
  el("btnAirline").addEventListener("click", () => {
    state.filterMode = "airlines";
    setSegActive(["btnAirline","btnOther","btnAll"], "btnAirline");
    savePrefs();
    render();
  });
  el("btnOther").addEventListener("click", () => {
    state.filterMode = "other";
    setSegActive(["btnAirline","btnOther","btnAll"], "btnOther");
    savePrefs();
    render();
  });
  el("btnAll").addEventListener("click", () => {
    state.filterMode = "all";
    setSegActive(["btnAirline","btnOther","btnAll"], "btnAll");
    savePrefs();
    render();
  });

  // Tier toggles
  const tierBtn = (id, key) => {
    el(id).addEventListener("click", () => {
      state.tiers[key] = !state.tiers[key];
      el(id).classList.toggle("active", state.tiers[key]);
      savePrefs();
      render();
    });
  };
  tierBtn("btnTier1", "t1");
  tierBtn("btnTier2", "t2");
  tierBtn("btnTier3", "t3");

  // Search
  el("search").addEventListener("input", (e) => {
    state.search = e.target.value || "";
    savePrefs();
    render();
  });

  // Buttons
  el("btnRefresh").addEventListener("click", async () => {
    await fetchFlights();
    await safeLoadRadar();
  });
  el("btnClearCache").addEventListener("click", () => {
    clearCache();
  });
}

function applyPrefsToUI() {
  // filter
  const m = state.filterMode;
  setSegActive(["btnAirline","btnOther","btnAll"],
    m === "airlines" ? "btnAirline" : (m === "other" ? "btnOther" : "btnAll")
  );

  // tiers
  el("btnTier1").classList.toggle("active", state.tiers.t1);
  el("btnTier2").classList.toggle("active", state.tiers.t2);
  el("btnTier3").classList.toggle("active", state.tiers.t3);

  // search
  el("search").value = state.search || "";
}

async function boot() {
  loadPrefs();
  loadCache();
  wireUI();
  applyPrefsToUI();
  render();

  await fetchFlights();
  await safeLoadRadar();

  // poll flights
  setInterval(fetchFlights, POLL_MS);
}

boot();