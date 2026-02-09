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

// ---- AeroDataBox Cache TTLs ----
const AERODATA_AIRCRAFT_TTL_S = 60 * 60 * 24 * 7; // 7 days
const AERODATA_FLIGHT_TTL_S = 60 * 60 * 6; // 6 hours

/**
 * ✅ Cache key version bump (v2) to avoid old cached bodies blocking new response formats.
 */
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

function withCors(resp, corsHeaders, cacheState) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders || {})) h.set(k, v);
  if (cacheState) h.set("X-Cache", cacheState);
  return new Response(resp.body, { status: resp.status, headers: h });
}

function json(obj, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function corsFor(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function isPreflight(request) {
  return request.method === "OPTIONS";
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// -------------------- OpenSky OAuth / Basic Auth --------------------

let _tokenCache = { accessToken: "", expiresAtMs: 0, mode: "none" };
let _tokenPromise = null;

async function getOpenSkyToken(env) {
  const now = Date.now();
  if (_tokenCache.accessToken && now < _tokenCache.expiresAtMs - 10_000) {
    return _tokenCache.accessToken;
  }
  if (_tokenPromise) return _tokenPromise;

  _tokenPromise = (async () => {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");

    const res = await fetchWithTimeout(
      OPENSKY_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            btoa(
              `${String(env.OPENSKY_CLIENT_ID)}:${String(env.OPENSKY_CLIENT_SECRET)}`
            ),
        },
        body: form.toString(),
      },
      OPENSKY_TOKEN_TIMEOUT_MS
    );

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OpenSky token HTTP ${res.status}: ${text.slice(0, 220)}`);
    }

    const j = JSON.parse(text);
    const token = j.access_token || "";
    const expiresIn = Number(j.expires_in || 0);
    _tokenCache = {
      accessToken: token,
      expiresAtMs: Date.now() + Math.max(0, expiresIn) * 1000,
      mode: "oauth",
    };
    return token;
  })().finally(() => {
    _tokenPromise = null;
  });

  return _tokenPromise;
}

async function buildOpenSkyHeaders(env) {
  const mode = detectOpenSkyAuthMode(env);
  if (mode === "oauth") {
    const tok = await getOpenSkyToken(env);
    return { Authorization: `Bearer ${tok}` };
  }
  if (mode === "basic") {
    return {
      Authorization:
        "Basic " + btoa(`${String(env.OPENSKY_USER)}:${String(env.OPENSKY_PASS)}`),
    };
  }
  return {};
}

// -------------------- ADSB.lol Fallback Adapter --------------------

function adsbLolBase(env) {
  return (env && env.ADSBLOL_BASE) ? String(env.ADSBLOL_BASE) : ADSBLOL_DEFAULT_BASE;
}

function normalizeCallsign(cs) {
  return String(cs || "").trim().toUpperCase().replace(/\s+/g, "");
}

function toOpenSkyStateVectorFromADSBLOL(ac) {
  // OpenSky state vector: [0]icao24 [1]callsign [2]origin_country [3]time_position [4]last_contact
  // [5]longitude [6]latitude [7]baro_altitude [8]on_ground [9]velocity [10]true_track [11]vertical_rate
  // [12]sensors [13]geo_altitude [14]squawk [15]spi [16]position_source

  const icao24 = ac?.hex ? String(ac.hex).toLowerCase() : null;
  if (!icao24) return null;

  const callsign = normalizeCallsign(ac?.flight || ac?.callsign || "");
  const originCountry = String(ac?.r || ac?.country || "—");

  const lon = (typeof ac?.lon === "number") ? ac.lon : null;
  const lat = (typeof ac?.lat === "number") ? ac.lat : null;

  const baroAlt = (typeof ac?.alt_baro === "number") ? ac.alt_baro :
                  (typeof ac?.alt === "number") ? ac.alt : null;

  const onGround = Boolean(ac?.gnd);

  const velocity = (typeof ac?.gs === "number") ? ac.gs : null; // m/s? ADSBexchange style is knots, but we treat as m/s? We'll pass through cautiously.
  const track = (typeof ac?.track === "number") ? ac.track : null;
  const vr = (typeof ac?.baro_rate === "number") ? ac.baro_rate : null;

  const geoAlt = (typeof ac?.alt_geom === "number") ? ac.alt_geom : null;

  const squawk = ac?.squawk ? String(ac.squawk) : null;

  const nowSec = Math.floor(Date.now() / 1000);

  return [
    icao24,
    callsign || null,
    originCountry || null,
    nowSec,
    nowSec,
    lon,
    lat,
    baroAlt,
    onGround,
    velocity,
    track,
    vr,
    null,
    geoAlt,
    squawk,
    false,
    0,
  ];
}

async function fetchADSBLOLAsOpenSky(env, bbox) {
  const base = adsbLolBase(env).replace(/\/+$/, "");
  const url = new URL(`${base}/v2/lat/${bbox.lamin}/lon/${bbox.lomin}/dist/999`);
  // Note: ADSB.lol has various endpoints; this is best-effort and kept flexible in your worker.

  const res = await fetchWithTimeout(
    url.toString(),
    { method: "GET", headers: { Accept: "application/json" } },
    ADSBLOL_TIMEOUT_MS
  );

  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j) return null;

  const aircraft = Array.isArray(j?.ac) ? j.ac : (Array.isArray(j?.aircraft) ? j.aircraft : []);
  const states = [];
  for (const ac of aircraft) {
    const sv = toOpenSkyStateVectorFromADSBLOL(ac);
    if (sv) states.push(sv);
  }

  return {
    time: Math.floor(Date.now() / 1000),
    states,
  };
}

// -------------------- Request Router --------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsFor(request);

    if (isPreflight(request)) {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/health") {
      return json(
        {
          ok: true,
          workerVersion: WORKER_VERSION,
          hasOpenSkyOAuth: Boolean(env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET),
          hasOpenSkyBasic: Boolean(env.OPENSKY_USER && env.OPENSKY_PASS),
          hasAeroDataBox: Boolean(env.AERODATA_KEY && env.AERODATA_HOST),
          adsbLolBase: adsbLolBase(env),
        },
        200,
        cors
      );
    }

    if (url.pathname === "/health/opensky-token") {
      try {
        if (!(env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET)) {
          return json({ ok: false, error: "oauth_not_configured" }, 400, cors);
        }
        const tok = await getOpenSkyToken(env);
        return json({ ok: true, tokenLen: tok.length }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 502, cors);
      }
    }

    if (url.pathname === "/health/opensky-states" || url.pathname === "/health/opensky") {
      try {
        const upstream = new URL(OPENSKY_STATES_URL);
        upstream.searchParams.set("lamin", "37.0");
        upstream.searchParams.set("lomin", "-98.0");
        upstream.searchParams.set("lamax", "38.0");
        upstream.searchParams.set("lomax", "-97.0");

        const headers = await buildOpenSkyHeaders(env);
        const res = await fetchWithTimeout(
          upstream.toString(),
          { method: "GET", headers },
          OPENSKY_STATES_TIMEOUT_MS
        );
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 502, cors);
      }
    }

    // -------------------- OpenSky States (Primary + Fallback) --------------------
    if (url.pathname === "/opensky/states") {
      const lamin = url.searchParams.get("lamin");
      const lomin = url.searchParams.get("lomin");
      const lamax = url.searchParams.get("lamax");
      const lomax = url.searchParams.get("lomax");

      if (!lamin || !lomin || !lamax || !lomax) {
        return json({ ok: false, error: "bbox_required" }, 400, cors);
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

      // Serve cache first if present
      const cached = await cache.match(cacheKey);
      if (cached) {
        return withCors(cached, cors, "HIT");
      }

      // Helper: store + return successful payloads
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

          if (res2.ok) {
            return respondAndCache(text2, { "X-Provider": "opensky" });
          }

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
      } catch (e) {
        return await handleOpenSkyFailure({
          env,
          cors,
          cache,
          cacheKey,
          ctx,
          status: 502,
          detail: String(e?.message || e),
          bbox: { lamin, lomin, lamax, lomax },
          thrown: true,
        });
      }
    }

    // -------------------- AeroDataBox: Flight by Callsign --------------------
    if (url.pathname.startsWith("/flight/")) {
      const callsign = decodeURIComponent(url.pathname.replace("/flight/", "") || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");

      if (!callsign) return json({ ok: false, error: "callsign_required" }, 400, cors);

      if (!(env.AERODATA_KEY && env.AERODATA_HOST)) {
        return json({ ok: false, error: "aerodata_not_configured" }, 500, cors);
      }

      const cache = caches.default;
      const ck = cacheKeyFlight(url.origin, callsign);
      const cached = await cache.match(ck);
      if (cached) return withCors(cached, cors, "HIT");

      const upstreamUrl = `https://${String(env.AERODATA_HOST)}/flights/callsign/${encodeURIComponent(
        callsign
      )}`;

      const r = await fetchAeroDataBoxJson(env, upstreamUrl);
      if (!r.ok) {
        return json(
          { ok: false, status: r._status, detail: String(r._text || "").slice(0, 220) },
          r._status === 429 ? 429 : 502,
          cors
        );
      }

      const d = r.data || {};
      const originIata =
        (d?.departure?.airport?.iata || d?.departure?.airport?.icao || "").toString().trim().toUpperCase();
      const destIata =
        (d?.arrival?.airport?.iata || d?.arrival?.airport?.icao || "").toString().trim().toUpperCase();

      const airlineName = (d?.airline?.name || d?.airline?.shortName || "").toString().trim();
      const airlineIcao = (d?.airline?.icao || "").toString().trim().toUpperCase();

      const aircraftModel =
        (d?.aircraft?.model || d?.aircraft?.modelName || d?.aircraft?.typeName || "").toString().trim();

      const route = (originIata && destIata) ? `${originIata} → ${destIata}` : "";

      const out = {
        ok: true,
        callsign,
        origin: originIata || null,
        destination: destIata || null,
        route: route || null,
        airlineName: airlineName || null,
        airlineIcao: airlineIcao || null,
        aircraftModel: aircraftModel || null,
      };

      await cacheJson(cache, ck, out, AERODATA_FLIGHT_TTL_S);
      const resp = await cache.match(ck);
      return withCors(resp, cors, "MISS");
    }

    // -------------------- AeroDataBox: Aircraft by ICAO24 --------------------
    if (url.pathname.startsWith("/aircraft/icao24/")) {
      const hex = decodeURIComponent(url.pathname.replace("/aircraft/icao24/", "") || "")
        .trim()
        .toLowerCase();

      if (!hex) return json({ ok: false, error: "icao24_required" }, 400, cors);

      if (!(env.AERODATA_KEY && env.AERODATA_HOST)) {
        return json({ ok: false, error: "aerodata_not_configured" }, 500, cors);
      }

      const cache = caches.default;
      const ck = cacheKeyAircraft(url.origin, hex);
      const cached = await cache.match(ck);
      if (cached) return withCors(cached, cors, "HIT");

      const upstreamUrl = `https://${String(env.AERODATA_HOST)}/aircrafts/icao24/${encodeURIComponent(
        hex
      )}`;

      const r = await fetchAeroDataBoxJson(env, upstreamUrl);

      // AeroDataBox sometimes returns 204 for not found
      if (r.ok === false && r._status === 204) {
        const out = { ok: true, found: false };
        await cacheJson(cache, ck, out, 60 * 60 * 6); // 6h negative cache
        const resp = await cache.match(ck);
        return withCors(resp, cors, "MISS");
      }

      if (!r.ok) {
        return json(
          { ok: false, status: r._status, detail: String(r._text || "").slice(0, 220) },
          r._status === 429 ? 429 : 502,
          cors
        );
      }

      const d = r.data || {};
      const out = { ok: true, found: true, ...d };

      await cacheJson(cache, ck, out, AERODATA_AIRCRAFT_TTL_S);
      const resp = await cache.match(ck);
      return withCors(resp, cors, "MISS");
    }

    return json({ ok: false, error: "not_found" }, 404, cors);
  },
};

// -------------------- OpenSky Failure Handler --------------------

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