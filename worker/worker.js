/**
 * FlightsAboveMe API Worker (v173)
 *
 * CHANGE (v173):
 *  - Disable warm enrichment entirely (no AeroDataBox calls triggered by /opensky/states)
 *  - Keep /flight and /aircraft endpoints cache-first (UI should call these ONLY for closest flight)
 *
 * Endpoints:
 *  - GET /health
 *  - GET /health/opensky-token
 *  - GET /health/opensky-states
 *  - GET /health/opensky
 *  - GET /opensky/states?lamin&lomin&lamax&lomax (bbox required)
 *  - GET /flight/<CALLSIGN> (AeroDataBox callsign lookup)
 *  - GET /aircraft/icao24/<HEX> (AeroDataBox aircraft lookup)
 *
 * OpenSky Auth Priority:
 *  1) OAuth2 Client Credentials (recommended)
 *     - OPENSKY_CLIENT_ID (Secret)
 *     - OPENSKY_CLIENT_SECRET (Secret)
 *  2) Legacy Basic Auth (if you still have it)
 *     - OPENSKY_USER (Secret)
 *     - OPENSKY_PASS (Secret)
 *
 * ADS-B Fallback (when OpenSky times out / errors / rate-limits):
 *  - Uses ADSB.lol (drop-in ADSBExchange-style API)
 *  - Env var (optional):
 *      ADSBLOL_BASE = "https://api.adsb.lol"
 *
 * Notes:
 *  - UI expects OpenSky-like "states" array-of-arrays. Fallback adapts ADSB.lol JSON into that shape.
 *  - Fallback is only used when OpenSky fails (network/timeout/5xx) or returns 429.
 */

const WORKER_VERSION = "v173";

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

// Timeouts: token fast, states longer (cellular/routing can be slower)
const OPENSKY_TOKEN_TIMEOUT_MS = 9000;
const OPENSKY_STATES_TIMEOUT_MS = 18000;

// ADSB.lol fallback
const ADSBLOL_DEFAULT_BASE = "https://api.adsb.lol";
const ADSBLOL_TIMEOUT_MS = 12000;

// ---- AeroDataBox Credit Efficiency ----
// ✅ v173: Warm cache enrichment disabled (UI should request enrich ONLY for closest flight)
const WARM_ENRICH_ENABLED = false;

// TTLs (defaults). Can be overridden with env vars:
//  - AERODATA_AIRCRAFT_TTL_S (default 604800 = 7 days)
//  - AERODATA_FLIGHT_TTL_S   (default 21600  = 6 hours)
//  - AERODATA_NEGATIVE_TTL_S (default 21600  = 6 hours)
const AERODATA_AIRCRAFT_TTL_S = 60 * 60 * 24 * 7; // 7 days
const AERODATA_FLIGHT_TTL_S = 60 * 60 * 6; // 6 hours
const AERODATA_NEGATIVE_TTL_S = 60 * 60 * 6; // 6 hours

const AERODATA_AIRCRAFT_TTL_VERIFIED_S = 60 * 60 * 24 * 30; // 30 days

// Optional (recommended): KV cache for aircraft metadata keyed by icao24.
// If AIRCRAFT_KV binding is not configured, the worker will fall back to Cache API only.
const AIRCRAFT_KV_TTL_S = 60 * 60 * 24 * 30; // 30 days (aircraft metadata rarely changes)

// Enrichment gating (kept for compatibility, but warm enrich disabled)
const ENRICH_MAX_REQUESTS_PER_CYCLE = 2;
const ENRICH_DIST_APPROACH_MI = 35;
const ENRICH_DIST_NEAR_MI = 15;
const ENRICH_DIST_OVERHEAD_MI = 8;

const ENRICH_DELTA_APPROACH_DEG = 75;
const ENRICH_DELTA_DEPART_DEG = 105;

// warm-enrich throttle keys (kept; warm enrich disabled)
const WARM_ENRICH_MIN_INTERVAL_S = 60;
const AERODATA_COOLDOWN_S = 120;
const AERODATA_429_CACHE_S = 30;

// Common cargo operators (avoid burning credits for flights you won't show under airlines)
const CARGO_PREFIX_BLOCKLIST = new Set([
  "FDX","UPS","GTI","ABX","CKS","PAC","POE","MXY","AJT","NCR","KFS","SRQ","RZO","OAE",
]);

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

function haversineMiles(lat1, lon1, lat2, lon2) {
  const Rm = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Rm * c;
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function deltaAngleDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function isLikelyPassengerCallsign(raw) {
  const cs = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  const m = cs.match(/^([A-Z]{3})(\d{1,5})([A-Z]?)$/);
  if (!m) return false;
  const prefix = m[1];
  if (CARGO_PREFIX_BLOCKLIST.has(prefix)) return false;
  return true;
}

function shouldWarmEnrich({ distanceMi, deltaDeg }) {
  if (distanceMi <= ENRICH_DIST_OVERHEAD_MI) return true;
  if (distanceMi <= ENRICH_DIST_NEAR_MI && deltaDeg < ENRICH_DELTA_DEPART_DEG) return true;
  if (distanceMi <= ENRICH_DIST_APPROACH_MI && deltaDeg <= ENRICH_DELTA_APPROACH_DEG) return true;
  return false;
}

function aerodataConfigured(env) {
  return Boolean(env && env.AERODATA_KEY && env.AERODATA_HOST);
}

function cacheKeyFlight(origin, callsign) {
  return new Request(
    `${origin}/__cache/aerodata/v2/flight/${encodeURIComponent(callsign)}`,
    { method: "GET" }
  );
}
function cacheKeyAircraft(origin, hex) {
  return new Request(
    `${origin}/__cache/aerodata/v2/aircraft/${encodeURIComponent(hex)}`,
    { method: "GET" }
  );
}

function quantize(n, step) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "na";
  return (Math.round(x / step) * step).toFixed(2);
}
function warmLockKey(origin, lamin, lomin, lamax, lomax, mode) {
  const cLat = (Number(lamin) + Number(lamax)) / 2;
  const cLon = (Number(lomin) + Number(lomax)) / 2;
  const qLat = quantize(cLat, 0.05);
  const qLon = quantize(cLon, 0.05);
  return new Request(
    `${origin}/__cache/aerodata/v2/warm_lock/${qLat}/${qLon}?mode=${encodeURIComponent(
      mode || "none"
    )}`,
    { method: "GET" }
  );
}

function aerodataCooldownKey(origin) {
  return new Request(`${origin}/__cache/aerodata/v2/cooldown`, { method: "GET" });
}

// ---- AeroDataBox Safety Locks (v1.4.1) ----
// Goals:
//  - Fast initial enrichment for closest flight
//  - Prevent credit burn when multiple users/devices refresh
//  - Enforce hard caps + cooldowns + stampede lock
//
// Notes:
//  - Uses Cache API for locks/counters so it works without KV bindings.
//  - If you later add KV, these helpers can be upgraded to true atomic counters.

function chicagoHour() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/Chicago" })
      .formatToParts(new Date());
    const h = parts.find(p => p.type === "hour")?.value;
    const n = Number(h);
    return Number.isFinite(n) ? n : new Date().getUTCHours();
  } catch {
    return new Date().getUTCHours();
  }
}

function isNightChicago() {
  const h = chicagoHour();
  return h >= 22 || h < 7; // 10pm–7am
}

function chicagoDateKey() {
  // YYYY-MM-DD in America/Chicago
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {}
  // Fallback: UTC date
  return new Date().toISOString().slice(0, 10);
}

function cacheKeyBudget(origin, dateKey) {
  return new Request(
    `${origin}/__cache/aerodata/v2/budget/${encodeURIComponent(dateKey)}`,
    { method: "GET" }
  );
}

async function budgetCanSpend(cache, origin, env, cors) {
  // Hard daily budget cap for AeroDataBox upstream calls.
  // Disabled by default (set AERODATA_DAILY_BUDGET to enable).
  const limit = envInt(env, "AERODATA_DAILY_BUDGET", 0);
  if (!limit || limit <= 0) return { ok: true, limit: 0, used: 0 };

  const dateKey = chicagoDateKey();
  const req = cacheKeyBudget(origin, dateKey);
  const hit = await cache.match(req);
  let used = 0;
  if (hit) {
    try {
      const j = await hit.json();
      used = Number(j?.used) || 0;
    } catch {
      used = 0;
    }
  }
  if (used >= limit) return { ok: false, limit, used, dateKey };

  // Best-effort increment (Cache API isn't atomic). Good enough to prevent most burn.
  const next = used + 1;
  await cachePutJson(
    cache,
    req,
    { used: next, limit, dateKey, ts: Date.now() },
    60 * 60 * 26,
    cors
  );
  return { ok: true, limit, used: next, dateKey };
}

function cacheKeyADB(origin, path) {
  return new Request(`${origin}/__cache/aerodata/v3/${path}`, { method: "GET" });
}

async function cacheGetJson(cache, req) {
  const hit = await cache.match(req);
  if (!hit) return null;
  try { return await hit.json(); } catch { return null; }
}

async function cachePutJson(cache, req, obj, ttlSeconds, cors) {
  const body = JSON.stringify(obj);
  const res = new Response(body, {
    status: 200,
    headers: {
      ...(cors || {}),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
    },
  });
  await cache.put(req, res);
}

// ---- KV helpers (optional) ----
function hasAircraftKV(env) {
  return Boolean(env && env.AIRCRAFT_KV && typeof env.AIRCRAFT_KV.get === "function");
}

function kvKeyAircraft(hex) {
  return `aircraft:${String(hex || "").trim().toLowerCase()}`;
}

async function kvGetAircraft(env, hex) {
  if (!hasAircraftKV(env)) return null;
  try {
    const v = await env.AIRCRAFT_KV.get(kvKeyAircraft(hex), { type: "json" });
    return v || null;
  } catch {
    return null;
  }
}

async function kvPutAircraft(env, hex, payload, ttlSeconds = AIRCRAFT_KV_TTL_S) {
  if (!hasAircraftKV(env)) return;
  try {
    await env.AIRCRAFT_KV.put(kvKeyAircraft(hex), JSON.stringify(payload), { expirationTtl: ttlSeconds });
  } catch {
    // ignore KV errors; Cache API remains as fallback
  }
}


// ---- D1 helpers (optional) ----
// D1 is used as permanent storage for aircraft enrichment results (KV is the fast cache).
function hasD1(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === "function");
}

async function d1GetAircraft(env, hex) {
  if (!hasD1(env)) return null;
  try {
    const h = String(hex || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT json FROM aircraft WHERE icao24 = ?").bind(h).first();
    if (!row || !row.json) return null;
    return JSON.parse(row.json);
  } catch {
    return null;
  }
}

async function d1PutAircraft(env, hex, payload) {
  if (!hasD1(env)) return;
  try {
    const h = String(hex || "").trim().toLowerCase();
    const jsonStr = JSON.stringify(payload);
    await env.DB.prepare(
      "INSERT INTO aircraft (icao24, json, updatedAt) VALUES (?, ?, ?) " +
      "ON CONFLICT(icao24) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt"
    ).bind(h, jsonStr, new Date().toISOString()).run();
  } catch {
    // ignore D1 errors
  }
}

function envBool(env, key, defVal = true) {
  const v = env?.[key];
  if (v === undefined || v === null || v === "") return defVal;
  const s = String(v).trim().toLowerCase();
  if (["0","false","no","off"].includes(s)) return false;
  if (["1","true","yes","on"].includes(s)) return true;
  return defVal;
}


function aircraftTtlS(env, record, fallbackTtlS) {
  const verifiedTtl = envInt(env, "AERODATA_AIRCRAFT_TTL_VERIFIED_S", AERODATA_AIRCRAFT_TTL_VERIFIED_S);
  const unverifiedTtl = envInt(env, "AERODATA_AIRCRAFT_TTL_UNVERIFIED_S", fallbackTtlS);
  const negTtl = envInt(env, "AERODATA_NEGATIVE_TTL_S", AERODATA_NEGATIVE_TTL_S);

  if (!record || typeof record !== "object") return fallbackTtlS;
  if (record.found === false) return negTtl;

  const v = record.verified;
  if (v === true) return verifiedTtl;
  return unverifiedTtl;
}

function adbTelemetryHeaders(kind, source, ttlS, record) {
  const verified =
    record && typeof record === "object" && Object.prototype.hasOwnProperty.call(record, "verified")
      ? (record.verified === true ? "1" : (record.verified === false ? "0" : "na"))
      : "na";
  return {
    "X-ADB-Kind": kind,
    "X-ADB-Source": source,
    "X-ADB-TTL": String(ttlS),
    "X-ADB-Verified": verified,
  };
}


function envInt(env, key, defVal) {
  const v = env?.[key];
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : defVal;
}

async function adbBudgetCheckAndBump({ cache, origin, env, cors, kind }) {
  // Budget units are counted per AeroDataBox call (not per response size).
  // Defaults are conservative; adjust via env vars:
  //  - ADBX_MAX_PER_DAY (default 250)
  //  - ADBX_MAX_PER_HOUR (default 60)
  //  - ADBX_NIGHT_MAX_PER_DAY (default 400)
  //  - ADBX_NIGHT_MAX_PER_HOUR (default 120)
  const night = isNightChicago();
  const maxDay = night ? envInt(env, "ADBX_NIGHT_MAX_PER_DAY", 400) : envInt(env, "ADBX_MAX_PER_DAY", 250);
  const maxHour = night ? envInt(env, "ADBX_NIGHT_MAX_PER_HOUR", 120) : envInt(env, "ADBX_MAX_PER_HOUR", 60);

  const now = new Date();
  const dayKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}-${String(now.getUTCDate()).padStart(2,"0")}`;
  const hourKey = `${dayKey}-${String(now.getUTCHours()).padStart(2,"0")}`;

  const dayReq = cacheKeyADB(origin, `budget/day/${dayKey}`);
  const hourReq = cacheKeyADB(origin, `budget/hour/${hourKey}`);

  const dayObj = (await cacheGetJson(cache, dayReq)) || { count: 0 };
  const hourObj = (await cacheGetJson(cache, hourReq)) || { count: 0 };

  if (dayObj.count >= maxDay) {
    return { ok: false, reason: "day_cap", max: maxDay, count: dayObj.count, night };
  }
  if (hourObj.count >= maxHour) {
    return { ok: false, reason: "hour_cap", max: maxHour, count: hourObj.count, night };
  }

  // Best-effort bump (not atomic). Still dramatically reduces runaway usage.
  dayObj.count += 1;
  hourObj.count += 1;

  // TTL: day counter ~26h, hour counter ~2h
  await cachePutJson(cache, dayReq, dayObj, 26 * 60 * 60, cors);
  await cachePutJson(cache, hourReq, hourObj, 2 * 60 * 60, cors);

  return { ok: true, night, day: dayObj.count, hour: hourObj.count, maxDay, maxHour };
}

async function adbShouldSkip({ cache, origin, env, cors, kind, id }) {
  // Global enable switch
  const enabled = envBool(env, "ADBX_ENABLED", true);
  if (!enabled) return { skip: true, code: "disabled" };

  // Respect existing 429 cooldown lockout if present
  const cooldownHit = await cache.match(aerodataCooldownKey(origin));
  if (cooldownHit) return { skip: true, code: "cooldown_429" };

  // Stampede lock: only one inflight enrichment per entity (prevents credit burn)
  const lockReq = cacheKeyADB(origin, `lock/inflight/${kind}/${encodeURIComponent(id)}`);
  const lockHit = await cache.match(lockReq);
  if (lockHit) return { skip: true, code: "locked" };

  // Global spacing (helps when many users refresh)
  const night = isNightChicago();
  const globalMinS = night ? envInt(env, "ADBX_GLOBAL_MIN_S_NIGHT", 10) : envInt(env, "ADBX_GLOBAL_MIN_S_DAY", 30);
  const globalReq = cacheKeyADB(origin, "lock/global-last");
  const globalHit = await cache.match(globalReq);
  if (globalHit) return { skip: true, code: "global_cooldown" };

  // Per-entity cooldown (prevents repeat enrichment for same id)
  const flightCdS = night ? envInt(env, "ADBX_FLIGHT_COOLDOWN_S_NIGHT", 10 * 60) : envInt(env, "ADBX_FLIGHT_COOLDOWN_S_DAY", 30 * 60);
  const acCdS = night ? envInt(env, "ADBX_AIRCRAFT_COOLDOWN_S_NIGHT", 6 * 60 * 60) : envInt(env, "ADBX_AIRCRAFT_COOLDOWN_S_DAY", 12 * 60 * 60);
  const cdS = kind === "aircraft" ? acCdS : flightCdS;

  const perReq = cacheKeyADB(origin, `cooldown/${kind}/${encodeURIComponent(id)}`);
  const perHit = await cache.match(perReq);
  if (perHit) return { skip: true, code: "entity_cooldown" };

  // Budget caps
  const b = await adbBudgetCheckAndBump({ cache, origin, env, cors, kind });
  if (!b.ok) return { skip: true, code: "budget", budget: b };

  // Acquire locks (best effort)
  await cachePutJson(cache, lockReq, { ts: Date.now(), kind, id }, 12, cors); // inflight lock (short)
  await cachePutJson(cache, globalReq, { ts: Date.now() }, globalMinS, cors); // global cooldown
  await cachePutJson(cache, perReq, { ts: Date.now() }, cdS, cors); // entity cooldown

  return { skip: false, night, budget: b, cdS, globalMinS };
}

async function cacheJson(cache, req, obj, ttlS) {
  await cache.put(
    req,
    new Response(JSON.stringify(obj), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${ttlS}`,
      },
    })
  );
}

async function fetchAeroDataBoxJson(env, upstreamUrl) {
  const res = await fetch(upstreamUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-RapidAPI-Key": String(env.AERODATA_KEY),
      "X-RapidAPI-Host": String(env.AERODATA_HOST),
    },
  });
  const text = await res.text();
  if (res.status === 429) return { ok: false, _status: 429, _text: text };
  if (!res.ok) return { ok: false, _status: res.status, _text: text };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, _status: 502, _text: "non_json" };
  }
}

// Warm-cache enrichment (kept, but disabled in v173 by WARM_ENRICH_ENABLED=false)
async function warmEnrichFromStates({ origin, env, cache, states, bboxCenter }) {
  if (!aerodataConfigured(env)) return;

  const cd = await cache.match(aerodataCooldownKey(origin));
  if (cd) return;

  const [cLat, cLon] = bboxCenter;

  const candidates = [];
  for (const s of states) {
    const icao24 = s && s[0] ? String(s[0]).trim().toLowerCase() : "";
    const callsignRaw = s && s[1] ? String(s[1]) : "";
    const lon = s && typeof s[5] === "number" ? s[5] : null;
    const lat = s && typeof s[6] === "number" ? s[6] : null;
    const track = s && typeof s[10] === "number" ? s[10] : null;

    if (!icao24 || !callsignRaw) continue;
    if (!isLikelyPassengerCallsign(callsignRaw)) continue;
    if (lat === null || lon === null || track === null) continue;

    const distanceMi = haversineMiles(lat, lon, cLat, cLon);
    if (distanceMi > ENRICH_DIST_APPROACH_MI) continue;

    const brg = bearingDeg(lat, lon, cLat, cLon);
    const deltaDeg = deltaAngleDeg(track, brg);

    if (!shouldWarmEnrich({ distanceMi, deltaDeg })) continue;

    const callsign = String(callsignRaw).trim().toUpperCase().replace(/\s+/g, "");
    candidates.push({ icao24, callsign, distanceMi, deltaDeg });
  }

  candidates.sort((a, b) => a.distanceMi - b.distanceMi);

  let budget = ENRICH_MAX_REQUESTS_PER_CYCLE;
  for (const c of candidates) {
    if (budget <= 0) break;

    const aKey = cacheKeyAircraft(origin, c.icao24);
    const aHit = await cache.match(aKey);
    if (!aHit && budget > 0) {
      const upstreamUrl = `https://${env.AERODATA_HOST}/aircrafts/icao24/${encodeURIComponent(c.icao24)}`;
      const out = await fetchAeroDataBoxJson(env, upstreamUrl);
      if (!out.ok && out._status === 429) {
        await cacheJson(cache, aerodataCooldownKey(origin), { ok: false, ts: Date.now(), reason: "429" }, AERODATA_COOLDOWN_S);
        break;
      }
      if (out.ok) {
        await cacheJson(cache, aKey, out.data, AERODATA_AIRCRAFT_TTL_S);
        budget--;
      }
    }

    const fKey = cacheKeyFlight(origin, c.callsign);
    const fHit = await cache.match(fKey);
    if (!fHit && budget > 0) {
      const upstreamUrl = `https://${env.AERODATA_HOST}/flights/callsign/${encodeURIComponent(c.callsign)}`;
      const out = await fetchAeroDataBoxJson(env, upstreamUrl);
      if (!out.ok && out._status === 429) {
        await cacheJson(cache, aerodataCooldownKey(origin), { ok: false, ts: Date.now(), reason: "429" }, AERODATA_COOLDOWN_S);
        break;
      }
      if (out.ok) {
        await cacheJson(cache, fKey, out.data, AERODATA_FLIGHT_TTL_S);
        budget--;
      }
    }
  }
}

// In-memory token cache (per Worker isolate)
let _tokenCache = { accessToken: "", expiresAtMs: 0, mode: "none" };
let _tokenPromise = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, ts: new Date().toISOString(), version: WORKER_VERSION }, 200, cors);
    }

    if (url.pathname === "/health/opensky-token") {
      return await openskyTokenHealth(env, cors);
    }
    if (url.pathname === "/health/opensky-states") {
      return await openskyStatesHealth(env, cors);
    }
    if (url.pathname === "/health/opensky") {
      return await openskyCombinedHealth(env, cors);
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "opensky" && parts[1] === "states") {
      const lamin = url.searchParams.get("lamin");
      const lomin = url.searchParams.get("lomin");
      const lamax = url.searchParams.get("lamax");
      const lomax = url.searchParams.get("lomax");

      if (!lamin || !lomin || !lamax || !lomax) {
        return json(
          { ok: false, error: "missing bbox params", hint: "lamin,lomin,lamax,lomax required" },
          400,
          cors
        );
      }

      const mode = detectOpenSkyAuthMode(env);

      const cacheKey = new Request(
        `${url.origin}/__cache/opensky/states?lamin=${encodeURIComponent(lamin)}&lomin=${encodeURIComponent(
          lomin
        )}&lamax=${encodeURIComponent(lamax)}&lomax=${encodeURIComponent(lomax)}&mode=${encodeURIComponent(mode)}`,
        { method: "GET" }
      );

      const upstream = new URL(OPENSKY_STATES_URL);
      upstream.searchParams.set("lamin", lamin);
      upstream.searchParams.set("lomin", lomin);
      upstream.searchParams.set("lamax", lamax);
      upstream.searchParams.set("lomax", lomax);

      const cache = caches.default;

      // v1.3.1 performance patch:
      // Serve cached /opensky/states immediately (fast on cellular) and refresh in background with a short lock.
      const refreshLock = new Request(
        `${url.origin}/__cache/opensky/states_refresh_lock?lamin=${encodeURIComponent(lamin)}&lomin=${encodeURIComponent(
          lomin
        )}&lamax=${encodeURIComponent(lamax)}&lomax=${encodeURIComponent(lomax)}&mode=${encodeURIComponent(mode)}`,
        { method: "GET" }
      );

      const cached = await cache.match(cacheKey);
      if (cached) {
        ctx.waitUntil(
          (async () => {
            try {
              const lockHit = await cache.match(refreshLock);
              if (lockHit) return;
              await cacheJson(cache, refreshLock, { ok: true, ts: Date.now() }, 6);

              const putStates = async (text, provider) => {
                await cache.put(
                  cacheKey,
                  new Response(text, {
                    status: 200,
                    headers: {
                      ...cors,
                      "Content-Type": "application/json; charset=utf-8",
                      "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
                      "X-Provider": provider || "opensky",
                    },
                  })
                );
              };

              // Try OpenSky first
              try {
                const headers = await buildOpenSkyHeaders(env);

                let res = await fetchWithTimeout(
                  upstream.toString(),
                  { method: "GET", headers },
                  OPENSKY_STATES_TIMEOUT_MS
                );
                let text = await res.text();

                if (!res.ok && res.status === 401 && _tokenCache.mode === "oauth") {
                  clearTokenCache();
                  const headers2 = await buildOpenSkyHeaders(env);
                  res = await fetchWithTimeout(
                    upstream.toString(),
                    { method: "GET", headers: headers2 },
                    OPENSKY_STATES_TIMEOUT_MS
                  );
                  text = await res.text();
                }

                if (res.ok) {
                  await putStates(text, "opensky");
                  return;
                }

                // On retryable errors, fall back to ADSB.lol to keep cache fresh
                const shouldFallback =
                  res.status === 429 ||
                  res.status === 502 ||
                  res.status === 503 ||
                  res.status === 504;

                if (shouldFallback) {
                  const adapted = await fetchADSBLOLAsOpenSky(env, { lamin, lomin, lamax, lomax });
                  if (adapted) {
                    await putStates(JSON.stringify(adapted), "adsb.lol");
                  }
                }
              } catch (e) {
                try {
                  const adapted = await fetchADSBLOLAsOpenSky(env, { lamin, lomin, lamax, lomax });
                  if (adapted) {
                    await cache.put(
                      cacheKey,
                      new Response(JSON.stringify(adapted), {
                        status: 200,
                        headers: {
                          ...cors,
                          "Content-Type": "application/json; charset=utf-8",
                          "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
                          "X-Provider": "adsb.lol",
                        },
                      })
                    );
                  }
                } catch {}
              }
            } catch {}
          })()
        );

        return withCors(cached, cors, "HIT");
      }

      const respondAndCache = (text, headersExtra = {}) => {
        const out = new Response(text, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
            ...headersExtra,
          },
        });
        ctx.waitUntil(cache.put(cacheKey, out.clone()));

        // ✅ v173: warm enrichment disabled to prevent AeroDataBox credit spikes
        if (WARM_ENRICH_ENABLED) {
          const bboxCenter = [
            (Number(lamin) + Number(lamax)) / 2,
            (Number(lomin) + Number(lomax)) / 2,
          ];

          ctx.waitUntil(
            (async () => {
              try {
                if (!aerodataConfigured(env)) return;

                const lockReq = warmLockKey(url.origin, lamin, lomin, lamax, lomax, mode);
                const lockHit = await cache.match(lockReq);
                if (lockHit) return;

                await cacheJson(cache, lockReq, { ok: true, ts: Date.now() }, WARM_ENRICH_MIN_INTERVAL_S);

                const j = JSON.parse(text);
                const states = Array.isArray(j?.states) ? j.states : [];
                if (states.length) {
                  await warmEnrichFromStates({ origin: url.origin, env, cache, states, bboxCenter });
                }
              } catch {}
            })()
          );
        }

        return out;
      };

      try {
        const headers = await buildOpenSkyHeaders(env);

        const res = await fetchWithTimeout(
          upstream.toString(),
          { method: "GET", headers },
          OPENSKY_STATES_TIMEOUT_MS
        );

        const text = await res.text();

        if (!res.ok && res.status === 401 && _tokenCache.mode === "oauth") {
          clearTokenCache();
          const headers2 = await buildOpenSkyHeaders(env);
          const res2 = await fetchWithTimeout(
            upstream.toString(),
            { method: "GET", headers: headers2 },
            OPENSKY_STATES_TIMEOUT_MS
          );
          const text2 = await res2.text();

          if (res2.ok) return respondAndCache(text2, { "X-Provider": "opensky" });

          return await handleOpenSkyFailure({
            env, cors, cache, cacheKey, ctx,
            status: res2.status, detail: text2, bbox: { lamin, lomin, lamax, lomax },
          });
        }

        if (res.ok) return respondAndCache(text, { "X-Provider": "opensky" });

        return await handleOpenSkyFailure({
          env, cors, cache, cacheKey, ctx,
          status: res.status, detail: text, bbox: { lamin, lomin, lamax, lomax },
        });
      } catch (err) {
        return await handleOpenSkyFailure({
          env, cors, cache, cacheKey, ctx,
          status: 522,
          detail: err && err.message ? err.message : "fetch_failed",
          bbox: { lamin, lomin, lamax, lomax },
          thrown: true,
        });
      }
    }

    // ---- AeroDataBox: Callsign ----
    if (parts[0] === "flight" && parts[1]) {
      const callsign = parts[1].trim().toUpperCase().replace(/\s+/g, "");
      if (!callsign) return json({ ok: false, error: "missing callsign" }, 400, cors);

      // TTLs (configurable)
      const FLIGHT_TTL_S = envInt(env, "AERODATA_FLIGHT_TTL_S", AERODATA_FLIGHT_TTL_S);
      const NEG_TTL_S = envInt(env, "AERODATA_NEGATIVE_TTL_S", AERODATA_NEGATIVE_TTL_S);

      if (!env.AERODATA_KEY || !env.AERODATA_HOST) {
        return json(
          { ok: false, error: "aerodata_not_configured", hint: "Set AERODATA_KEY (Secret) and AERODATA_HOST (Text)" },
          500,
          cors
        );
      }

      const cache = caches.default;
      const ck = cacheKeyFlight(url.origin, callsign);

      const hit = await cache.match(ck);
      if (hit) return withCors(hit, cors, "HIT");

      // Callsign gate: avoid burning credits on cargo/private patterns.
      // Can be disabled with env var: ADBX_CALLSIGN_GATE=0
      const gateCallsign = envBool(env, "ADBX_CALLSIGN_GATE", true);
      if (gateCallsign && !isLikelyPassengerCallsign(callsign)) {
        const payload = { ok: false, callsign, error: "unsupported_callsign" };
        const out = new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${NEG_TTL_S}, s-maxage=${NEG_TTL_S}`,
            "X-Cache": "NEG",
            ...adbTelemetryHeaders("flight", "GATED", NEG_TTL_S, null),
          },
        });
        ctx.waitUntil(cache.put(ck, out.clone()));
        return out;
      }


      // Safety locks: throttle + budget + cooldown + stampede protection
      const gate = await adbShouldSkip({ cache, origin: url.origin, env, cors, kind: "flight", id: callsign });
      if (gate.skip) {
        return json({ ok: false, callsign, error: "aerodata_throttled", reason: gate.code }, 200, cors);
      }

      // Optional hard daily budget cap (set AERODATA_DAILY_BUDGET to enable)
      const budget = await budgetCanSpend(cache, url.origin, env, cors);
      if (!budget.ok) {
        // "User sees nothing" mode: don't leak budget limits or return error JSON.
        // If there's no cached enrichment and the budget is exhausted, return 204.
        const out = new Response(null, {
          status: 204,
          headers: {
            ...cors,
            "Cache-Control": "public, max-age=60, s-maxage=60",
          },
        });
        ctx.waitUntil(cache.put(ck, out.clone()));
        return out;
      }
      const upstreamUrl = `https://${env.AERODATA_HOST}/flights/callsign/${encodeURIComponent(callsign)}`;

      try {
        const res = await fetch(upstreamUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-RapidAPI-Key": String(env.AERODATA_KEY),
            "X-RapidAPI-Host": String(env.AERODATA_HOST),
          },
        });

        const text = await res.text();

        // Negative-cache not-found cases so repeated lookups don't burn credits.
        if (res.status === 204 || res.status === 404) {
          const payload = { ok: true, found: false, callsign };
          const out = new Response(JSON.stringify(payload), {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": `public, max-age=${NEG_TTL_S}, s-maxage=${NEG_TTL_S}`,
              "X-Cache": "NEG",
              ...adbTelemetryHeaders("aircraft", "NEG", NEG_TTL_S, nf),
            },
          });
          ctx.waitUntil(cache.put(ck, out.clone()));
          return out;
        }

        if (res.status === 429) {
          const out = new Response(
            JSON.stringify({ ok: false, callsign, error: "rate_limited", status: 429 }),
            {
              status: 429,
              headers: {
                ...cors,
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": `public, max-age=${AERODATA_429_CACHE_S}, s-maxage=${AERODATA_429_CACHE_S}`,
              },
            }
          );
          ctx.waitUntil(cache.put(ck, out.clone()));
          ctx.waitUntil(cacheJson(cache, aerodataCooldownKey(url.origin), { ok: false, ts: Date.now(), reason: "429" }, AERODATA_COOLDOWN_S));
          return out;
        }

        if (!res.ok) {
          return json(
            { ok: false, callsign, error: "aerodata_upstream_error", status: res.status, detail: text.slice(0, 220) },
            502,
            cors
          );
        }

        let data;
        try { data = JSON.parse(text); }
        catch { return json({ ok: false, callsign, error: "aerodata_non_json" }, 502, cors); }

        const f = Array.isArray(data) ? data[0] : data;
        if (!f) {
          const payload = { ok: true, found: false, callsign };
          const out = new Response(JSON.stringify(payload), {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": `public, max-age=${NEG_TTL_S}, s-maxage=${NEG_TTL_S}`,
              "X-Cache": "NEG",
              ...adbTelemetryHeaders("aircraft", "NEG", NEG_TTL_S, nf),
            },
          });
          ctx.waitUntil(cache.put(ck, out.clone()));
          return out;
        }
        const origin = f?.departure?.airport || null;
        const destination = f?.arrival?.airport || null;

        const payload = {
          ok: true,
          callsign,
          origin,
          destination,
          airlineName: f?.airline?.name || f?.airline?.shortName || null,
          airlineIcao: f?.airline?.icao || f?.airline?.icaoCode || f?.airline?.icaoCodeShort || null,
          airlineIata: f?.airline?.iata || f?.airline?.iataCode || f?.airline?.iataCodeShort || null,
          operatorIcao: f?.operator?.icao || f?.operator?.icaoCode || null,
          operatorIata: f?.operator?.iata || f?.operator?.iataCode || null,
          aircraftModel: f?.aircraft?.model || f?.aircraft?.modelCode || null,
          aircraftType: f?.aircraft?.typeName || f?.aircraft?.iataCodeShort || f?.aircraft?.icaoCode || null,
          route: origin && destination ? `${fmtEnd(origin)} → ${fmtEnd(destination)}` : "unavailable",
          source: "aerodatabox",
        };

        const out = new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${FLIGHT_TTL_S}, s-maxage=${FLIGHT_TTL_S}`,
            ...adbTelemetryHeaders("flight", "UPSTREAM", FLIGHT_TTL_S, payload),
          },
        });

        ctx.waitUntil(cache.put(ck, out.clone()));
        return out;
      } catch (err) {
        return json(
          { ok: false, callsign, error: "aerodata_fetch_failed", detail: err && err.message ? err.message : "unknown" },
          502,
          cors
        );
      }
    }

    // ---- AeroDataBox: Aircraft by ICAO24 ----
    if (parts[0] === "aircraft" && parts[1] === "icao24" && parts[2]) {
      const hex = parts[2].trim().toLowerCase();
      if (!hex) return json({ ok: false, error: "missing icao24" }, 400, cors);

      // TTLs (configurable)
      const AIRCRAFT_TTL_S = envInt(env, "AERODATA_AIRCRAFT_TTL_S", AERODATA_AIRCRAFT_TTL_S);
      const NEG_TTL_S = envInt(env, "AERODATA_NEGATIVE_TTL_S", AERODATA_NEGATIVE_TTL_S);

      const ttlFor = (rec) => aircraftTtlS(env, rec, AIRCRAFT_TTL_S);

      if (!env.AERODATA_KEY || !env.AERODATA_HOST) {
        return json(
          { ok: false, error: "aerodata_not_configured", hint: "Set AERODATA_KEY (Secret) and AERODATA_HOST (Text)" },
          500,
          cors
        );
      }

      const cache = caches.default;
      const ck = cacheKeyAircraft(url.origin, hex);

      // 1) Global KV cache (fast + shared across locations)
      const kvHit = await kvGetAircraft(env, hex);
      if (kvHit) {
        const ttlS = ttlFor(kvHit);
        const out = new Response(JSON.stringify(kvHit), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${ttlS}, s-maxage=${ttlS}`,
            "X-Cache": "KV",
            ...adbTelemetryHeaders("aircraft", "KV", ttlS, kvHit),
          },
        });
        return out;
      }


      // 2) D1 (permanent DB) — repopulates KV after KV expires
      const d1Hit = await d1GetAircraft(env, hex);
      if (d1Hit) {
        const ttlS = ttlFor(d1Hit);
        ctx.waitUntil(kvPutAircraft(env, hex, d1Hit, AIRCRAFT_KV_TTL_S));
        const out = new Response(JSON.stringify(d1Hit), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${ttlS}, s-maxage=${ttlS}`,
            "X-Cache": "D1",
            ...adbTelemetryHeaders("aircraft", "D1", ttlS, d1Hit),
          },
        });
        // also refresh Cache API for compatibility
        ctx.waitUntil(cache.put(ck, out.clone()));
        return out;
      }

      const hit = await cache.match(ck);
      if (hit) return withCors(hit, cors, "HIT");


      // Safety locks: throttle + budget + cooldown + stampede protection
      const gate = await adbShouldSkip({ cache, origin: url.origin, env, cors, kind: "aircraft", id: hex });
      if (gate.skip) {
        return json({ ok: false, icao24: hex, error: "aerodata_throttled", reason: gate.code }, 200, cors);
      }

      // Optional hard daily budget cap (set AERODATA_DAILY_BUDGET to enable)
      const budget = await budgetCanSpend(cache, url.origin, env, cors);
      if (!budget.ok) {
        // "User sees nothing" mode: don't leak budget limits or return error JSON.
        // If there's no cached enrichment and the budget is exhausted, return 204.
        const out = new Response(null, {
          status: 204,
          headers: {
            ...cors,
            "Cache-Control": "public, max-age=60, s-maxage=60",
          },
        });
        ctx.waitUntil(cache.put(ck, out.clone()));
        return out;
      }
      const upstreamUrl = `https://${env.AERODATA_HOST}/aircrafts/icao24/${encodeURIComponent(hex)}`;

      try {
        const res = await fetch(upstreamUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-RapidAPI-Key": String(env.AERODATA_KEY),
            "X-RapidAPI-Host": String(env.AERODATA_HOST),
          },
        });

        if (res.status === 429) {
          const out = new Response(
            JSON.stringify({ ok: false, icao24: hex, error: "rate_limited", status: 429 }),
            {
              status: 429,
              headers: {
                ...cors,
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": `public, max-age=${AERODATA_429_CACHE_S}, s-maxage=${AERODATA_429_CACHE_S}`,
              },
            }
          );
          ctx.waitUntil(cache.put(ck, out.clone()));
          ctx.waitUntil(cacheJson(cache, aerodataCooldownKey(url.origin), { ok: false, ts: Date.now(), reason: "429" }, AERODATA_COOLDOWN_S));
          return out;
        }

        if (res.status === 404) {
          const nf = { ok: true, found: false, icao24: hex };
          const out = new Response(JSON.stringify(nf), {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": `public, max-age=${NEG_TTL_S}, s-maxage=${NEG_TTL_S}`,
              "X-Cache": "NEG",
            },
          });
          ctx.waitUntil(cache.put(ck, out.clone()));
          ctx.waitUntil(kvPutAircraft(env, hex, nf, NEG_TTL_S));
          return out;
        }

        if (res.status === 204) {
          const nf = { ok: true, found: false, icao24: hex };
          const out = new Response(JSON.stringify(nf), {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": `public, max-age=${NEG_TTL_S}, s-maxage=${NEG_TTL_S}`,
              "X-Cache": "NEG",
            },
          });
          ctx.waitUntil(cache.put(ck, out.clone()));
          // Cache negative results briefly to avoid repeat lookups
          ctx.waitUntil(kvPutAircraft(env, hex, nf, NEG_TTL_S));
          return out;
        }

        const text = await res.text();
        if (!res.ok) {
          return json(
            { ok: false, icao24: hex, error: "aerodata_upstream_error", status: res.status, detail: text.slice(0, 220) },
            502,
            cors
          );
        }

        let raw;
        try { raw = JSON.parse(text); }
        catch { return json({ ok: false, icao24: hex, error: "aerodata_non_json" }, 502, cors); }

        const payload = { ok: true, icao24: hex, ...raw };

        const ttlS = ttlFor(payload);

        const out = new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${ttlS}, s-maxage=${ttlS}`,
            ...adbTelemetryHeaders("aircraft", "UPSTREAM", ttlS, payload),
          },
        });

        ctx.waitUntil(cache.put(ck, out.clone()));
        ctx.waitUntil(kvPutAircraft(env, hex, payload, AIRCRAFT_KV_TTL_S));
        ctx.waitUntil(d1PutAircraft(env, hex, payload));
        return out;
      } catch (err) {
        return json(
          { ok: false, icao24: hex, error: "aerodata_fetch_failed", detail: err && err.message ? err.message : "unknown" },
          502,
          cors
        );
      }
    }

    return new Response("FlightsAboveMe API worker", { status: 200, headers: cors });
  },
};

// -------------------- OpenSky Failure Handler (cache → ADSB.lol → error) --------------------

async function handleOpenSkyFailure({ env, cors, cache, cacheKey, ctx, status, detail, bbox, thrown }) {
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached, cors, "HIT-STALE");

  const shouldFallback =
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 522 ||
    thrown === true ||
    (typeof detail === "string" && /timeout/i.test(detail));

  if (shouldFallback) {
    try {
      const adapted = await fetchADSBLOLAsOpenSky(env, bbox);
      if (adapted) {
        const out = new Response(JSON.stringify(adapted), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
            "X-Provider": "adsb.lol",
          },
        });
        ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      }
    } catch (e) {}
  }

  return json(
    {
      ok: false,
      error: thrown ? "opensky_fetch_failed" : "opensky_upstream_error",
      status,
      detail: typeof detail === "string" ? detail.slice(0, 220) : "unknown",
    },
    status === 429 ? 429 : 502,
    cors
  );
}

    // Serve ads.txt at the domain root for Google AdSense / authorized digital sellers.
    // NOTE: This worker has a catch-all route that otherwise serves the UI, so we must
    // explicitly handle /ads.txt here.
    if (url.pathname === "/ads.txt") {
      return new Response(
        "google.com, pub-4157780114857674, DIRECT, f08c47fec0942fa0\n",
        {
          status: 200,
          headers: {
            ...cors,
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        }
      );
    }


// -------------------- OpenSky Auth Helpers --------------------

function detectOpenSkyAuthMode(env) {
  if (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) return "oauth";
  if (env.OPENSKY_USER && env.OPENSKY_PASS) return "basic";
  return "none";
}

function clearTokenCache() {
  _tokenCache = { accessToken: "", expiresAtMs: 0, mode: "none" };
  _tokenPromise = null;
}

async function buildOpenSkyHeaders(env) {
  const headers = { Accept: "application/json" };
  const mode = detectOpenSkyAuthMode(env);

  if (mode === "oauth") {
    const token = await getOpenSkyAccessToken(env);
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (mode === "basic") {
    const user = String(env.OPENSKY_USER || "");
    const pass = String(env.OPENSKY_PASS || "");
    if (user && pass) headers.Authorization = "Basic " + btoa(`${user}:${pass}`);
  }

  return headers;
}

async function getOpenSkyAccessToken(env) {
  const now = Date.now();

  if (_tokenCache.mode === "oauth" && _tokenCache.accessToken && now < _tokenCache.expiresAtMs - 15_000) {
    return _tokenCache.accessToken;
  }

  if (_tokenPromise) return _tokenPromise;

  _tokenPromise = (async () => {
    try {
      const clientId = String(env.OPENSKY_CLIENT_ID || "");
      const clientSecret = String(env.OPENSKY_CLIENT_SECRET || "");
      if (!clientId || !clientSecret) return "";

      const body = new URLSearchParams();
      body.set("grant_type", "client_credentials");
      body.set("client_id", clientId);
      body.set("client_secret", clientSecret);

      const res = await fetchWithTimeout(
        OPENSKY_TOKEN_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        },
        OPENSKY_TOKEN_TIMEOUT_MS
      );

      const text = await res.text();
      if (!res.ok) return "";

      let data = null;
      try { data = JSON.parse(text); } catch { return ""; }

      const token = String(data?.access_token || "");
      const expiresIn = Number(data?.expires_in || 0);

      if (token && expiresIn > 0) {
        _tokenCache = { accessToken: token, expiresAtMs: Date.now() + expiresIn * 1000, mode: "oauth" };
      }

      return token;
    } finally {
      _tokenPromise = null;
    }
  })();

  return _tokenPromise;
}

// -------------------- ADSB.lol Fallback (adapt to OpenSky "states") --------------------

function feetToMeters(ft) {
  const n = Number(ft);
  return Number.isFinite(n) ? n * 0.3048 : NaN;
}
function knotsToMps(knots) {
  const n = Number(knots);
  return Number.isFinite(n) ? n * 0.514444 : NaN;
}
function fpmToMps(fpm) {
  const n = Number(fpm);
  return Number.isFinite(n) ? (n * 0.3048) / 60 : NaN;
}

async function fetchADSBLOLAsOpenSky(env, bbox) {
  const base = (env.ADSBLOL_BASE && String(env.ADSBLOL_BASE)) || ADSBLOL_DEFAULT_BASE;

  const lamin = Number(bbox.lamin);
  const lomin = Number(bbox.lomin);
  const lamax = Number(bbox.lamax);
  const lomax = Number(bbox.lomax);
  if (![lamin, lomin, lamax, lomax].every(Number.isFinite)) return null;

  const clat = (lamin + lamax) / 2;
  const clon = (lomin + lomax) / 2;

  const r1 = haversineKm(clat, clon, lamin, lomin);
  const r2 = haversineKm(clat, clon, lamin, lomax);
  const r3 = haversineKm(clat, clon, lamax, lomin);
  const r4 = haversineKm(clat, clon, lamax, lomax);
  const radiusKm = Math.max(r1, r2, r3, r4);

  const url = new URL(`${base}/v2/lat/${clat}/lon/${clon}/dist/${Math.ceil(radiusKm)}`);

  const res = await fetchWithTimeout(url.toString(), { method: "GET" }, ADSBLOL_TIMEOUT_MS);
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  if (!data) return null;

  const aircraft = data.ac || data.aircraft || data.planes || [];
  if (!Array.isArray(aircraft)) return null;

  const nowSec = Math.floor(Date.now() / 1000);

  const states = aircraft
    .map((p) => {
      const icao24 = (p.hex || p.icao || p.icao24 || "").toString().toLowerCase();
      const callsign = (p.flight || p.callsign || "").toString();
      const lon = num(p.lon);
      const lat = num(p.lat);

      if (!icao24 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      const altFt = num(p.alt_baro != null ? p.alt_baro : p.altitude);
      const baro_alt_m = Number.isFinite(altFt) ? feetToMeters(altFt) : NaN;

      const on_ground = !!p.gnd;

      const gsKnots = num(p.gs != null ? p.gs : p.speed);
      const velocity_mps = Number.isFinite(gsKnots) ? knotsToMps(gsKnots) : NaN;

      const true_track = num(p.track != null ? p.track : p.trak);

      const vrFpm = num(p.vrate != null ? p.vrate : p.vr);
      const vertical_rate_mps = Number.isFinite(vrFpm) ? fpmToMps(vrFpm) : NaN;

      const geoFt = num(p.alt_geom != null ? p.alt_geom : p.altitude_geom);
      const geo_alt_m = Number.isFinite(geoFt) ? feetToMeters(geoFt) : NaN;

      const time_position = toInt(p.seen_pos != null ? nowSec - Number(p.seen_pos) : nowSec);
      const last_contact = toInt(p.seen != null ? nowSec - Number(p.seen) : nowSec);

      const squawk = (p.squawk || "").toString() || null;

      // Best-effort aircraft type/model hint (provider-specific).
      // If present, we append it as an extra field so the UI can display a fallback model until enrichment loads.
      const typeHintRaw = (p.t ?? p.type ?? p.aircraft_type ?? p.aircraftType ?? p.ac_type ?? p.icaoType ?? p.model ?? "").toString().trim();
      const typeHint = (typeHintRaw && typeHintRaw.length <= 16) ? typeHintRaw : null;

      return [
        icao24, callsign, "",
        time_position || null,
        last_contact || null,
        lon, lat,
        Number.isFinite(baro_alt_m) ? baro_alt_m : null,
        on_ground,
        Number.isFinite(velocity_mps) ? velocity_mps : null,
        Number.isFinite(true_track) ? true_track : null,
        Number.isFinite(vertical_rate_mps) ? vertical_rate_mps : null,
        null,
        Number.isFinite(geo_alt_m) ? geo_alt_m : null,
        squawk,
        false,
        0,
        typeHint,
      ];
    })
    .filter(Boolean);

  return { time: nowSec, states };
}

// -------------------- Utilities --------------------

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

function withCors(res, cors, cacheHint) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  if (cacheHint) h.set("X-Cache", cacheHint);
  return new Response(res.body, { status: res.status, headers: h });
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// -------------------- Health Endpoints --------------------

async function openskyTokenHealth(env, cors) {
  const mode = detectOpenSkyAuthMode(env);
  if (mode !== "oauth") {
    return json({ ok: true, mode, hint: "OAuth not configured; using basic/none" }, 200, cors);
  }
  try {
    const token = await getOpenSkyAccessToken(env);
    return json({ ok: !!token, mode: "oauth", tokenCached: !!_tokenCache.accessToken }, 200, cors);
  } catch (e) {
    return json({ ok: false, mode: "oauth", error: "token_fetch_failed" }, 502, cors);
  }
}

async function openskyStatesHealth(env, cors) {
  const mode = detectOpenSkyAuthMode(env);
  try {
    const headers = await buildOpenSkyHeaders(env);

    const upstream = new URL(OPENSKY_STATES_URL);
    upstream.searchParams.set("lamin", "39.7");
    upstream.searchParams.set("lomin", "-104.99");
    upstream.searchParams.set("lamax", "39.9");
    upstream.searchParams.set("lomax", "-104.7");

    const res = await fetchWithTimeout(upstream.toString(), { method: "GET", headers }, OPENSKY_STATES_TIMEOUT_MS);
    const text = await res.text();
    return json(
      { ok: res.ok, authMode: mode, status: res.status, sample: text ? text.slice(0, 160) : "" },
      200,
      cors
    );
  } catch (e) {
    return json({ ok: false, authMode: mode, error: "states_fetch_failed" }, 502, cors);
  }
}

async function openskyCombinedHealth(env, cors) {
  const mode = detectOpenSkyAuthMode(env);
  const tokenPart = await openskyTokenHealth(env, {});
  const tokenJson = await tokenPart.json().catch(() => ({}));

  const statesPart = await openskyStatesHealth(env, {});
  const statesJson = await statesPart.json().catch(() => ({}));

  return json(
    { ok: !!tokenJson.ok && !!statesJson.ok, authMode: mode, token: tokenJson, states: statesJson },
    200,
    cors
  );
}

// -------------------- Formatting helpers --------------------

function nm(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v).trim();
  }
  if (typeof v === "object") {
    return nm(
      v.name ??
        v.city ??
        v.municipality ??
        v.municipalityName ??
        v.location ??
        v.label ??
        v.value ??
        v.code ??
        v.iata ??
        v.icao
    );
  }
  return "";
}

function fmtEnd(a) {
  if (!a) return "";
  const code = nm(a.iata || a.iataCode || a.icao || a.icaoCode || "");
  const city = nm(a.municipality || a.municipalityName || a.city || a.location || "");
  const name = nm(a.name || "");
  const best = city || name;
  if (best && code) return `${best} (${code})`;
  return best || code || "";
}
