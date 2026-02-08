/**
 * FlightsAboveMe API Worker (v171)
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
 *    If not set, defaults to https://api.adsb.lol
 *
 * Notes:
 *  - UI expects OpenSky-like "states" array-of-arrays. Fallback adapts ADSB.lol JSON into that shape.
 *  - Fallback is only used when OpenSky fails (network/timeout/5xx) or returns 429.
 */

const WORKER_VERSION = "v171";

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

// Timeouts: token fast, states longer (cellular/routing can be slower)
const OPENSKY_TOKEN_TIMEOUT_MS = 9000;
const OPENSKY_STATES_TIMEOUT_MS = 18000;

// ADSB.lol fallback
const ADSBLOL_DEFAULT_BASE = "https://api.adsb.lol";
const ADSBLOL_TIMEOUT_MS = 12000;

// ---- AeroDataBox Credit Efficiency (Warm Cache Enrichment) ----

// TTLs
const AERODATA_AIRCRAFT_TTL_S = 60 * 60 * 24 * 7; // 7 days
const AERODATA_FLIGHT_TTL_S = 60 * 60 * 6; // 6 hours

// Enrichment gating (miles / degrees)
const ENRICH_MAX_REQUESTS_PER_CYCLE = 2;
const ENRICH_DIST_APPROACH_MI = 35;
const ENRICH_DIST_NEAR_MI = 15;
const ENRICH_DIST_OVERHEAD_MI = 8;

const ENRICH_DELTA_APPROACH_DEG = 75;
const ENRICH_DELTA_DEPART_DEG = 105;

// Common cargo operators (avoid burning credits for flights you won't show under airlines)
const CARGO_PREFIX_BLOCKLIST = new Set([
  "FDX",
  "UPS",
  "GTI",
  "ABX",
  "CKS",
  "PAC",
  "POE",
  "MXY",
  "AJT",
  "NCR",
  "KFS",
  "SRQ",
  "RZO",
  "OAE",
]);

function toRad(d) {
  return (d * Math.PI) / 180;
}
function toDeg(r) {
  return (r * 180) / Math.PI;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const Rm = 3958.7613; // Earth radius miles
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

// Bearing from point1 -> point2, degrees [0,360)
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1),
    φ2 = toRad(lat2);
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

// Conservative "likely passenger airline" heuristic (prevents wasting credits on GA/private/military)
function isLikelyPassengerCallsign(raw) {
  const cs = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  // Typical airline callsign: 3 letters + digits (e.g., AAL1234). We keep this conservative.
  const m = cs.match(/^([A-Z]{3})(\d{1,5})([A-Z]?)$/);
  if (!m) return false;
  const prefix = m[1];
  if (CARGO_PREFIX_BLOCKLIST.has(prefix)) return false;
  return true;
}

function shouldWarmEnrich({ distanceMi, deltaDeg }) {
  if (distanceMi <= ENRICH_DIST_OVERHEAD_MI) return true;
  if (distanceMi <= ENRICH_DIST_NEAR_MI && deltaDeg < ENRICH_DELTA_DEPART_DEG)
    return true;
  if (
    distanceMi <= ENRICH_DIST_APPROACH_MI &&
    deltaDeg <= ENRICH_DELTA_APPROACH_DEG
  )
    return true;
  return false;
}

function aerodataConfigured(env) {
  return Boolean(env && env.AERODATA_KEY && env.AERODATA_HOST);
}

function cacheKeyFlight(origin, callsign) {
  return new Request(
    `${origin}/__cache/aerodata/flight/${encodeURIComponent(callsign)}`,
    { method: "GET" }
  );
}
function cacheKeyAircraft(origin, hex) {
  return new Request(
    `${origin}/__cache/aerodata/aircraft/${encodeURIComponent(hex)}`,
    { method: "GET" }
  );
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

// Warm-cache enrichment kicked off from /opensky/states response.
// Uses bbox center as a proxy for observer location (UI remains unchanged).
async function warmEnrichFromStates({ origin, env, cache, states, bboxCenter }) {
  if (!aerodataConfigured(env)) return;

  const [cLat, cLon] = bboxCenter;

  // Build candidate list with distance + heading delta
  const candidates = [];
  for (const s of states) {
    // OpenSky state vector indices:
    // 0 icao24, 1 callsign, 5 lon, 6 lat, 10 true_track
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

    const callsign = String(callsignRaw)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
    candidates.push({ icao24, callsign, distanceMi, deltaDeg });
  }

  candidates.sort((a, b) => a.distanceMi - b.distanceMi);

  let budget = ENRICH_MAX_REQUESTS_PER_CYCLE;

  for (const c of candidates) {
    if (budget <= 0) break;

    // Aircraft warm cache (long TTL)
    const aKey = cacheKeyAircraft(origin, c.icao24);
    const aHit = await cache.match(aKey);
    if (!aHit && budget > 0) {
      const upstreamUrl = `https://${env.AERODATA_HOST}/aircrafts/icao24/${encodeURIComponent(
        c.icao24
      )}`;
      const out = await fetchAeroDataBoxJson(env, upstreamUrl);
      if (out.ok) {
        await cacheJson(cache, aKey, out.data, AERODATA_AIRCRAFT_TTL_S);
        budget--;
      }
    }

    // Flight warm cache (shorter TTL)
    const fKey = cacheKeyFlight(origin, c.callsign);
    const fHit = await cache.match(fKey);
    if (!fHit && budget > 0) {
      const upstreamUrl = `https://${env.AERODATA_HOST}/flights/callsign/${encodeURIComponent(
        c.callsign
      )}`;
      const out = await fetchAeroDataBoxJson(env, upstreamUrl);
      if (out.ok) {
        await cacheJson(cache, fKey, out.data, AERODATA_FLIGHT_TTL_S);
        budget--;
      }
    }
  }
}

// In-memory token cache (per Worker isolate)
let _tokenCache = {
  accessToken: "",
  expiresAtMs: 0,
  mode: "none", // "oauth" | "basic" | "none"
};
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

    // ---- Health ----
    if (url.pathname === "/health") {
      return json(
        { ok: true, ts: new Date().toISOString(), version: WORKER_VERSION },
        200,
        cors
      );
    }

    // ---- OpenSky debug endpoints (safe; no secrets/tokens returned) ----
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

    // ---- OpenSky States (with ADSB.lol fallback + edge caching) ----
    if (parts[0] === "opensky" && parts[1] === "states") {
      const lamin = url.searchParams.get("lamin");
      const lomin = url.searchParams.get("lomin");
      const lamax = url.searchParams.get("lamax");
      const lomax = url.searchParams.get("lomax");

      if (!lamin || !lomin || !lamax || !lomax) {
        return json(
          {
            ok: false,
            error: "missing bbox params",
            hint: "lamin,lomin,lamax,lomax required",
          },
          400,
          cors
        );
      }

      const mode = detectOpenSkyAuthMode(env);

      // Cache by bbox + auth mode (avoid mixing anon/auth results)
      const cacheKey = new Request(
        `${url.origin}/__cache/opensky/states?lamin=${encodeURIComponent(
          lamin
        )}&lomin=${encodeURIComponent(
          lomin
        )}&lamax=${encodeURIComponent(
          lamax
        )}&lomax=${encodeURIComponent(lomax)}&mode=${encodeURIComponent(mode)}`,
        { method: "GET" }
      );

      const upstream = new URL(OPENSKY_STATES_URL);
      upstream.searchParams.set("lamin", lamin);
      upstream.searchParams.set("lomin", lomin);
      upstream.searchParams.set("lamax", lamax);
      upstream.searchParams.set("lomax", lomax);

      const cache = caches.default;

      // Helper: store + return successful payloads
      const respondAndCache = (text, headersExtra = {}) => {
        const out = new Response(text, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            // short cache to cut request volume, plus SWR to keep UI alive during upstream hiccups
            "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
            ...headersExtra,
          },
        });
        ctx.waitUntil(cache.put(cacheKey, out.clone()));
        // Warm AeroDataBox cache asynchronously (UI contract unchanged)
        const bboxCenter = [
          (Number(lamin) + Number(lamax)) / 2,
          (Number(lomin) + Number(lomax)) / 2,
        ];
        ctx.waitUntil(
          (async () => {
            try {
              const j = JSON.parse(text);
              const states = Array.isArray(j?.states) ? j.states : [];
              if (states.length)
                await warmEnrichFromStates({
                  origin: url.origin,
                  env,
                  cache,
                  states,
                  bboxCenter,
                });
            } catch {}
          })()
        );
        return out;
      };

      // 1) Try OpenSky
      try {
        const headers = await buildOpenSkyHeaders(env);

        const res = await fetchWithTimeout(
          upstream.toString(),
          { method: "GET", headers },
          OPENSKY_STATES_TIMEOUT_MS
        );

        const text = await res.text();

        // If unauthorized and we used OAuth, clear token and retry once
        if (!res.ok && res.status === 401 && _tokenCache.mode === "oauth") {
          clearTokenCache();
          const headers2 = await buildOpenSkyHeaders(env);
          const res2 = await fetchWithTimeout(
            upstream.toString(),
            { method: "GET", headers: headers2 },
            OPENSKY_STATES_TIMEOUT_MS
          );
          const text2 = await res2.text();

          if (res2.ok) {
            return respondAndCache(text2, { "X-Provider": "opensky" });
          }

          // OpenSky failed even after retry: fall through to cache/fallback
          return await handleOpenSkyFailure({
            env,
            cors,
            cache,
            cacheKey,
            ctx,
            status: res2.status,
            detail: text2,
            bbox: { lamin, lomin, lamax, lomax },
          });
        }

        if (res.ok) {
          return respondAndCache(text, { "X-Provider": "opensky" });
        }

        // OpenSky non-OK: try cache → fallback → error
        return await handleOpenSkyFailure({
          env,
          cors,
          cache,
          cacheKey,
          ctx,
          status: res.status,
          detail: text,
          bbox: { lamin, lomin, lamax, lomax },
        });
      } catch (err) {
        // OpenSky fetch threw (timeout/network): try cache → fallback → error
        return await handleOpenSkyFailure({
          env,
          cors,
          cache,
          cacheKey,
          ctx,
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

      if (!env.AERODATA_KEY || !env.AERODATA_HOST) {
        return json(
          {
            ok: false,
            error: "aerodata_not_configured",
            hint: "Set AERODATA_KEY (Secret) and AERODATA_HOST (Text)",
          },
          500,
          cors
        );
      }

      const cache = caches.default;
      const ck = cacheKeyFlight(url.origin, callsign);

      // Cache-first: serve last-known-good (prevents credit burn + improves kiosk stability)
      const hit = await cache.match(ck);
      if (hit) return withCors(hit, cors, "HIT");

      const upstreamUrl = `https://${env.AERODATA_HOST}/flights/callsign/${encodeURIComponent(
        callsign
      )}`;

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
        if (res.status === 429)
          return json(
            { ok: false, callsign, error: "rate_limited", status: 429 },
            429,
            cors
          );
        if (!res.ok)
          return json(
            {
              ok: false,
              callsign,
              error: "aerodata_upstream_error",
              status: res.status,
              detail: text.slice(0, 220),
            },
            502,
            cors
          );

        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return json({ ok: false, callsign, error: "aerodata_non_json" }, 502, cors);
        }

        const f = Array.isArray(data) ? data[0] : data;
        const origin = f?.departure?.airport || null;
        const destination = f?.arrival?.airport || null;

        const payload = {
          ok: true,
          callsign,
          origin,
          destination,
          airlineName: f?.airline?.name || f?.airline?.shortName || null,
          airlineIcao:
            f?.airline?.icao ||
            f?.airline?.icaoCode ||
            f?.airline?.icaoCodeShort ||
            null,
          airlineIata:
            f?.airline?.iata ||
            f?.airline?.iataCode ||
            f?.airline?.iataCodeShort ||
            null,
          operatorIcao: f?.operator?.icao || f?.operator?.icaoCode || null,
          operatorIata: f?.operator?.iata || f?.operator?.iataCode || null,
          aircraftModel: f?.aircraft?.model || f?.aircraft?.modelCode || null,
          aircraftType:
            f?.aircraft?.typeName ||
            f?.aircraft?.iataCodeShort ||
            f?.aircraft?.icaoCode ||
            null,
          route:
            origin && destination
              ? `${fmtEnd(origin)} → ${fmtEnd(destination)}`
              : "unavailable",
          source: "aerodatabox",
        };

        const out = new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${AERODATA_FLIGHT_TTL_S}, s-maxage=${AERODATA_FLIGHT_TTL_S}`,
          },
        });

        ctx.waitUntil(cache.put(ck, out.clone()));
        return out;
      } catch (err) {
        return json(
          {
            ok: false,
            callsign,
            error: "aerodata_fetch_failed",
            detail: err && err.message ? err.message : "unknown",
          },
          502,
          cors
        );
      }
    }

    // ---- AeroDataBox: Aircraft by ICAO24 ----
    if (parts[0] === "aircraft" && parts[1] === "icao24" && parts[2]) {
      const hex = parts[2].trim().toLowerCase();
      if (!hex) return json({ ok: false, error: "missing icao24" }, 400, cors);

      if (!env.AERODATA_KEY || !env.AERODATA_HOST) {
        return json(
          {
            ok: false,
            error: "aerodata_not_configured",
            hint: "Set AERODATA_KEY (Secret) and AERODATA_HOST (Text)",
          },
          500,
          cors
        );
      }

      const cache = caches.default;
      const ck = cacheKeyAircraft(url.origin, hex);

      // Cache-first: serve last-known-good
      const hit = await cache.match(ck);
      if (hit) return withCors(hit, cors, "HIT");

      const upstreamUrl = `https://${env.AERODATA_HOST}/aircrafts/icao24/${encodeURIComponent(
        hex
      )}`;

      try {
        const res = await fetch(upstreamUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-RapidAPI-Key": String(env.AERODATA_KEY),
            "X-RapidAPI-Host": String(env.AERODATA_HOST),
          },
        });

        if (res.status === 204) {
          const out = new Response(
            JSON.stringify({ ok: true, found: false, icao24: hex }),
            {
              status: 200,
              headers: {
                ...cors,
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "public, max-age=21600, s-maxage=21600",
              },
            }
          );
          ctx.waitUntil(cache.put(ck, out.clone()));
          return out;
        }

        const text = await res.text();
        if (res.status === 429)
          return json(
            { ok: false, icao24: hex, error: "rate_limited", status: 429 },
            429,
            cors
          );
        if (!res.ok)
          return json(
            {
              ok: false,
              icao24: hex,
              error: "aerodata_upstream_error",
              status: res.status,
              detail: text.slice(0, 220),
            },
            502,
            cors
          );

        // ✅ FIX: wrap aircraft JSON with ok:true so UI enrichment accepts it
        let raw;
        try {
          raw = JSON.parse(text);
        } catch {
          return json({ ok: false, icao24: hex, error: "aerodata_non_json" }, 502, cors);
        }

        const payload = {
          ok: true,
          icao24: hex,
          ...raw,
        };

        const out = new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${AERODATA_AIRCRAFT_TTL_S}, s-maxage=${AERODATA_AIRCRAFT_TTL_S}`,
          },
        });

        ctx.waitUntil(cache.put(ck, out.clone()));
        return out;
      } catch (err) {
        return json(
          {
            ok: false,
            icao24: hex,
            error: "aerodata_fetch_failed",
            detail: err && err.message ? err.message : "unknown",
          },
          502,
          cors
        );
      }
    }

    return new Response("FlightsAboveMe API worker", { status: 200, headers: cors });
  },
};

// -------------------- OpenSky Failure Handler (cache → ADSB.lol → error) --------------------

async function handleOpenSkyFailure({
  env,
  cors,
  cache,
  cacheKey,
  ctx,
  status,
  detail,
  bbox,
  thrown,
}) {
  // 1) Serve cached if available
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached, cors, "HIT-STALE");

  // 2) If OpenSky rate-limited or timed out / networked out, try ADSB.lol fallback
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

        // Warm AeroDataBox cache asynchronously (UI contract unchanged)
        try {
          const bboxCenter = [
            (Number(bbox.lamin) + Number(bbox.lamax)) / 2,
            (Number(bbox.lomin) + Number(bbox.lomax)) / 2,
          ];
          const origin = new URL(cacheKey.url).origin;
          ctx.waitUntil(
            (async () => {
              try {
                const states = Array.isArray(adapted?.states) ? adapted.states : [];
                if (states.length)
                  await warmEnrichFromStates({
                    origin,
                    env,
                    cache,
                    states,
                    bboxCenter,
                  });
              } catch {}
            })()
          );
        } catch {}

        return out;
      }
    } catch (e) {
      // fall through
    }
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

  if (
    _tokenCache.mode === "oauth" &&
    _tokenCache.accessToken &&
    now < _tokenCache.expiresAtMs - 15_000
  ) {
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
      try {
        data = JSON.parse(text);
      } catch {
        return "";
      }

      const token = String(data?.access_token || "");
      const expiresIn = Number(data?.expires_in || 0);

      if (token && expiresIn > 0) {
        _tokenCache = {
          accessToken: token,
          expiresAtMs: Date.now() + expiresIn * 1000,
          mode: "oauth",
        };
      }

      return token;
    } finally {
      _tokenPromise = null;
    }
  })();

  return _tokenPromise;
}

// -------------------- ADSB.lol Fallback (adapt to OpenSky "states") --------------------
// FIXED: correct OpenSky indices + unit conversions so ALT/DIR work when fallback is used.

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
  const base =
    (env.ADSBLOL_BASE && String(env.ADSBLOL_BASE)) || ADSBLOL_DEFAULT_BASE;

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

  const url = new URL(
    `${base}/v2/lat/${clat}/lon/${clon}/dist/${Math.ceil(radiusKm)}`
  );

  const res = await fetchWithTimeout(
    url.toString(),
    { method: "GET" },
    ADSBLOL_TIMEOUT_MS
  );
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  if (!data) return null;

  const aircraft = data.ac || data.aircraft || data.planes || [];
  if (!Array.isArray(aircraft)) return null;

  const nowSec = Math.floor(Date.now() / 1000);

  // OpenSky format (array indices):
  // 0 icao24
  // 1 callsign
  // 2 origin_country
  // 3 time_position
  // 4 last_contact
  // 5 longitude
  // 6 latitude
  // 7 baro_altitude (meters)
  // 8 on_ground
  // 9 velocity (m/s)
  // 10 true_track (deg)
  // 11 vertical_rate (m/s)
  // 12 sensors
  // 13 geo_altitude (meters)
  // 14 squawk
  // 15 spi
  // 16 position_source
  const states = aircraft
    .map((p) => {
      const icao24 = (p.hex || p.icao || p.icao24 || "")
        .toString()
        .toLowerCase();
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

      const time_position = toInt(
        p.seen_pos != null ? nowSec - Number(p.seen_pos) : nowSec
      );
      const last_contact = toInt(
        p.seen != null ? nowSec - Number(p.seen) : nowSec
      );

      const squawk = (p.squawk || "").toString() || null;

      return [
        icao24,
        callsign,
        "",
        time_position || null,
        last_contact || null,
        lon,
        lat,
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
      ];
    })
    .filter(Boolean);

  return { time: nowSec, states };
}

// -------------------- Utilities --------------------

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
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
    return json(
      { ok: true, mode, hint: "OAuth not configured; using basic/none" },
      200,
      cors
    );
  }
  try {
    const token = await getOpenSkyAccessToken(env);
    return json(
      { ok: !!token, mode: "oauth", tokenCached: !!_tokenCache.accessToken },
      200,
      cors
    );
  } catch (e) {
    return json(
      { ok: false, mode: "oauth", error: "token_fetch_failed" },
      502,
      cors
    );
  }
}

async function openskyStatesHealth(env, cors) {
  const mode = detectOpenSkyAuthMode(env);
  try {
    const headers = await buildOpenSkyHeaders(env);

    // Tiny bbox (required by states endpoint handler)
    const upstream = new URL(OPENSKY_STATES_URL);
    upstream.searchParams.set("lamin", "39.7");
    upstream.searchParams.set("lomin", "-104.99");
    upstream.searchParams.set("lamax", "39.9");
    upstream.searchParams.set("lomax", "-104.7");

    const res = await fetchWithTimeout(
      upstream.toString(),
      { method: "GET", headers },
      OPENSKY_STATES_TIMEOUT_MS
    );

    const text = await res.text();
    return json(
      {
        ok: res.ok,
        authMode: mode,
        status: res.status,
        sample: text ? text.slice(0, 160) : "",
      },
      200,
      cors
    );
  } catch (e) {
    return json(
      { ok: false, authMode: mode, error: "states_fetch_failed" },
      502,
      cors
    );
  }
}

async function openskyCombinedHealth(env, cors) {
  const mode = detectOpenSkyAuthMode(env);
  const tokenPart = await openskyTokenHealth(env, {});
  const tokenJson = await tokenPart.json().catch(() => ({}));

  const statesPart = await openskyStatesHealth(env, {});
  const statesJson = await statesPart.json().catch(() => ({}));

  return json(
    {
      ok: !!tokenJson.ok && !!statesJson.ok,
      authMode: mode,
      token: tokenJson,
      states: statesJson,
    },
    200,
    cors
  );
}

// -------------------- Formatting helpers --------------------

/**
 * OBJECT-SAFE normalizer.
 * AeroDataBox sometimes returns nested objects for fields like municipality/city.
 * This ensures we always return a clean string (prevents "[object Object]" in UI).
 */
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
  const city = nm(a.municipality || a.city || a.location || "");
  const name = nm(a.name || "");
  const best = city || name;

  if (best && code) return `${best} (${code})`;
  return best || code || "";
}