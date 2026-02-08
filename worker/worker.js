/**
 * FlightWall API Worker (v170)
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
 * Stability goals:
 *  - Longer OpenSky timeout (cellular/routing can be slower)
 *  - Cache last-known-good states per bbox + auth mode
 *  - ✅ CACHE-FIRST states: serve cached immediately; refresh in background
 *    - prevents blank kiosk during OpenSky slowness/timeouts
 *  - Serve cached states if OpenSky times out / 429s
 */

const WORKER_VERSION = "v170";

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

// Timeouts: token fast, states longer (OpenSky can be slow on some routes)
const OPENSKY_TOKEN_TIMEOUT_MS = 9000;
const OPENSKY_STATES_TIMEOUT_MS = 18000;

// Cache policy for states (edge)
const STATES_CACHE_CONTROL = "public, max-age=10, s-maxage=30, stale-while-revalidate=120";

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
      return json({ ok: true, ts: new Date().toISOString(), version: WORKER_VERSION }, 200, cors);
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

    // ---- OpenSky States (CACHE-FIRST) ----
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

      // Cache by bbox + auth mode (avoid mixing anon/auth results)
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

      // ✅ CACHE-FIRST: if we have cached states, return immediately and refresh in background.
      const cached = await cache.match(cacheKey);
      if (cached) {
        ctx.waitUntil(refreshOpenSkyStates(cache, cacheKey, upstream, env, cors));
        return withCors(cached, cors, "HIT");
      }

      // Cache miss: fetch live (and populate cache)
      try {
        const fresh = await fetchOpenSkyStatesOnce(upstream, env, cors);
        const out = new Response(fresh.bodyText, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": STATES_CACHE_CONTROL,
          },
        });
        ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      } catch (err) {
        // No cache + live failed => bubble error (prevents “silent blank”)
        return json(
          { ok: false, error: "opensky_fetch_failed", detail: err && err.message ? err.message : "unknown" },
          502,
          cors
        );
      }
    }

    // ---- AeroDataBox: Callsign ----
    if (parts[0] === "flight" && parts[1]) {
      const callsign = parts[1].trim().toUpperCase().replace(/\s+/g, "");
      if (!callsign) return json({ ok: false, error: "missing callsign" }, 400, cors);

      if (!env.AERODATA_KEY || !env.AERODATA_HOST) {
        return json(
          { ok: false, error: "aerodata_not_configured", hint: "Set AERODATA_KEY (Secret) and AERODATA_HOST (Text)" },
          500,
          cors
        );
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
        if (res.status === 429) return json({ ok: false, callsign, error: "rate_limited", status: 429 }, 429, cors);
        if (!res.ok)
          return json(
            { ok: false, callsign, error: "aerodata_upstream_error", status: res.status, detail: text.slice(0, 220) },
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

        return new Response(
          JSON.stringify({
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
          }),
          {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=30, s-maxage=300",
            },
          }
        );
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

      if (!env.AERODATA_KEY || !env.AERODATA_HOST) {
        return json(
          { ok: false, error: "aerodata_not_configured", hint: "Set AERODATA_KEY (Secret) and AERODATA_HOST (Text)" },
          500,
          cors
        );
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

        if (res.status === 204) {
          return new Response(JSON.stringify({ ok: true, found: false, icao24: hex }), {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=30, s-maxage=600",
            },
          });
        }

        const text = await res.text();
        if (res.status === 429) return json({ ok: false, icao24: hex, error: "rate_limited", status: 429 }, 429, cors);
        if (!res.ok)
          return json(
            { ok: false, icao24: hex, error: "aerodata_upstream_error", status: res.status, detail: text.slice(0, 220) },
            502,
            cors
          );

        return new Response(text, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=3600, s-maxage=21600",
          },
        });
      } catch (err) {
        return json(
          { ok: false, icao24: hex, error: "aerodata_fetch_failed", detail: err && err.message ? err.message : "unknown" },
          502,
          cors
        );
      }
    }

    return new Response("FlightWall API worker", { status: 200, headers: cors });
  },
};

// -------------------- OpenSky CACHE-FIRST refresh --------------------

async function refreshOpenSkyStates(cache, cacheKey, upstream, env, cors) {
  try {
    const fresh = await fetchOpenSkyStatesOnce(upstream, env, cors);
    if (!fresh || !fresh.ok) return;

    const out = new Response(fresh.bodyText, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": STATES_CACHE_CONTROL,
      },
    });

    await cache.put(cacheKey, out);
  } catch {
    // Swallow refresh errors: cache-first means users keep seeing last-known-good.
  }
}

/**
 * Fetch states once with auth + OAuth retry-on-401 logic.
 * Returns: { ok:true, bodyText:string } or throws Error("...") on hard failure.
 *
 * Notes:
 * - On 429: throw a special error so caller can keep cached.
 * - On non-OK: throw with status + snippet.
 */
async function fetchOpenSkyStatesOnce(upstream, env, cors) {
  let headers = await buildOpenSkyHeaders(env);

  let res = await fetchWithTimeout(upstream.toString(), { method: "GET", headers }, OPENSKY_STATES_TIMEOUT_MS);

  // If unauthorized and we used OAuth, clear token and retry once
  if (!res.ok && res.status === 401 && _tokenCache.mode === "oauth") {
    clearTokenCache();
    headers = await buildOpenSkyHeaders(env);
    res = await fetchWithTimeout(upstream.toString(), { method: "GET", headers }, OPENSKY_STATES_TIMEOUT_MS);
  }

  const text = await res.text();

  if (res.status === 429) {
    throw new Error(`opensky_rate_limited: ${text.slice(0, 120)}`);
  }

  if (!res.ok) {
    throw new Error(`opensky_http_${res.status}: ${text.slice(0, 220)}`);
  }

  return { ok: true, bodyText: text };
}

// -------------------- OpenSky Health --------------------

async function openskyTokenHealth(env, cors) {
  const mode = detectOpenSkyAuthMode(env);
  if (mode !== "oauth") {
    return json({ ok: false, authMode: mode, hint: "Set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET" }, 200, cors);
  }

  try {
    const token = await getOAuthToken(env, true);
    return json(
      {
        ok: !!token,
        authMode: mode,
        tokenCached: _tokenCache.expiresAtMs > Date.now(),
      },
      200,
      cors
    );
  } catch (err) {
    return json(
      { ok: false, authMode: mode, error: "token_fetch_failed", detail: err && err.message ? err.message : "unknown" },
      200,
      cors
    );
  }
}

async function openskyStatesHealth(env, cors) {
  const mode = detectOpenSkyAuthMode(env);

  // tiny bbox (reduces load and improves responsiveness)
  const upstream = new URL(OPENSKY_STATES_URL);
  upstream.searchParams.set("lamin", "36.05");
  upstream.searchParams.set("lomin", "-94.20");
  upstream.searchParams.set("lamax", "36.25");
  upstream.searchParams.set("lomax", "-93.95");

  try {
    const headers = await buildOpenSkyHeaders(env);
    const res = await fetchWithTimeout(upstream.toString(), { method: "GET", headers }, OPENSKY_STATES_TIMEOUT_MS);

    const rateRemaining =
      res.headers.get("x-rate-limit-remaining") ||
      res.headers.get("X-Rate-Limit-Remaining") ||
      null;

    if (!res.ok) {
      const text = await res.text();
      return json(
        {
          ok: false,
          authMode: mode,
          openskyStatus: res.status,
          rateRemaining,
          detail: text.slice(0, 220),
        },
        200,
        cors
      );
    }

    // Don't dump full payload; just confirm it's shaped right
    let statesCount = null;
    try {
      const data = await res.json();
      statesCount = Array.isArray(data?.states) ? data.states.length : null;
    } catch {
      // ignore
    }

    return json(
      {
        ok: true,
        authMode: mode,
        openskyStatus: res.status,
        rateRemaining,
        statesCount,
      },
      200,
      cors
    );
  } catch (err) {
    return json(
      { ok: false, authMode: mode, error: "opensky_fetch_failed", detail: err && err.message ? err.message : "unknown" },
      200,
      cors
    );
  }
}

async function openskyCombinedHealth(env, cors) {
  const mode = detectOpenSkyAuthMode(env);

  const tokenPart = { ok: null };
  const statesPart = { ok: null };

  if (mode === "oauth") {
    try {
      const token = await getOAuthToken(env, false);
      tokenPart.ok = !!token;
      tokenPart.tokenCached = _tokenCache.expiresAtMs > Date.now();
    } catch (e) {
      tokenPart.ok = false;
      tokenPart.detail = e && e.message ? e.message : "unknown";
    }
  } else {
    tokenPart.ok = mode === "basic" ? null : false;
  }

  try {
    const r = await openskyStatesHealth(env, cors);
    const body = await r.json();
    statesPart.ok = !!body.ok;
    statesPart.openskyStatus = body.openskyStatus || null;
    statesPart.statesCount = body.statesCount ?? null;
    statesPart.rateRemaining = body.rateRemaining ?? null;
    if (!statesPart.ok) statesPart.detail = body.detail || body.error || null;
  } catch (e) {
    statesPart.ok = false;
    statesPart.detail = e && e.message ? e.message : "unknown";
  }

  return json(
    {
      ok: !!statesPart.ok,
      authMode: mode,
      token: tokenPart,
      states: statesPart,
    },
    200,
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
  const headers = {
    Accept: "application/json",
    "User-Agent": "FlightsAboveMe-Worker",
  };

  if (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) {
    const token = await getOAuthToken(env, false);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      return headers;
    }
  }

  if (env.OPENSKY_USER && env.OPENSKY_PASS) {
    const token = btoa(`${env.OPENSKY_USER}:${env.OPENSKY_PASS}`);
    headers.Authorization = `Basic ${token}`;
  }

  return headers;
}

async function getOAuthToken(env, forceRefresh) {
  const now = Date.now();

  if (!forceRefresh) {
    if (_tokenCache.mode === "oauth" && _tokenCache.accessToken && _tokenCache.expiresAtMs > now + 10_000) {
      return _tokenCache.accessToken;
    }
  }

  if (_tokenPromise) return _tokenPromise;

  _tokenPromise = (async () => {
    try {
      const clientId = String(env.OPENSKY_CLIENT_ID || "").trim();
      const clientSecret = String(env.OPENSKY_CLIENT_SECRET || "").trim();
      if (!clientId || !clientSecret) throw new Error("missing_client_credentials");

      const body = new URLSearchParams();
      body.set("grant_type", "client_credentials");
      body.set("client_id", clientId);
      body.set("client_secret", clientSecret);

      const res = await fetchWithTimeout(
        OPENSKY_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "FlightsAboveMe-Worker",
          },
          body: body.toString(),
        },
        OPENSKY_TOKEN_TIMEOUT_MS
      );

      const text = await res.text();
      if (!res.ok) {
        clearTokenCache();
        throw new Error(`token_http_${res.status}: ${text.slice(0, 120)}`);
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        clearTokenCache();
        throw new Error("token_non_json");
      }

      const accessToken = String(data?.access_token || "").trim();
      const expiresInSec = Number(data?.expires_in || 1800);

      if (!accessToken) {
        clearTokenCache();
        throw new Error("token_missing_access_token");
      }

      const safeExpiresIn = Math.max(60, expiresInSec - 60);

      _tokenCache = {
        accessToken,
        expiresAtMs: Date.now() + safeExpiresIn * 1000,
        mode: "oauth",
      };

      return accessToken;
    } finally {
      _tokenPromise = null;
    }
  })();

  return _tokenPromise;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function withCors(response, corsHeaders, cacheHint) {
  const h = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([k, v]) => h.set(k, v));
  if (cacheHint) h.set("X-Cache", cacheHint);

  return new Response(response.body, { status: response.status, headers: h });
}

// -------------------- Common Helpers --------------------

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function fmtEnd(airport) {
  if (!airport || typeof airport !== "object") return "";
  const city = (airport.municipalityName || airport.city || "")
    .toString()
    .trim()
    .replace(/\/+\s*$/, "");
  const code = (airport.iata || airport.icao || "").toString().trim();
  const name = (airport.name || "").toString().trim();
  const bestCity = city || (name ? name.split(" ")[0] : "");
  if (bestCity && code) return `${bestCity} (${code})`;
  return bestCity || code || "";
}