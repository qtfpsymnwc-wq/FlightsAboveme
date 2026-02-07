/**
 * FlightWall API Worker (v169)
 *
 * Endpoints:
 *  - GET /health
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
 */

const WORKER_VERSION = "v169";

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

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

    // ---- OpenSky health check (safe; no token/secret output) ----
    if (url.pathname === "/health/opensky") {
      return await openskyHealth(env, cors);
    }

    const parts = url.pathname.split("/").filter(Boolean);

    // ---- OpenSky States ----
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

      try {
        const headers = await buildOpenSkyHeaders(env);

        // IMPORTANT: keep OpenSky timeout tight to avoid hanging the UI
        const res = await fetchWithTimeout(upstream.toString(), { method: "GET", headers }, 9000);
        const text = await res.text();

        // If unauthorized and we used OAuth, clear token and retry once
        if (!res.ok && res.status === 401 && _tokenCache.mode === "oauth") {
          clearTokenCache();
          const headers2 = await buildOpenSkyHeaders(env);
          const res2 = await fetchWithTimeout(upstream.toString(), { method: "GET", headers: headers2 }, 9000);
          const text2 = await res2.text();

          if (!res2.ok) {
            // If upstream fails, fall back to cached response if available
            const cached = await cache.match(cacheKey);
            if (cached) return withCors(cached, cors, "HIT-STALE");
            return json(
              { ok: false, error: "opensky_upstream_error", status: res2.status, detail: text2.slice(0, 220) },
              502,
              cors
            );
          }

          const out2 = new Response(text2, {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              // tiny cache + allow serving slightly stale if OpenSky hiccups
              "Cache-Control": "public, max-age=2, s-maxage=5, stale-while-revalidate=25",
            },
          });

          ctx.waitUntil(cache.put(cacheKey, out2.clone()));
          return out2;
        }

        if (!res.ok) {
          // If upstream fails, fall back to cached response if available
          const cached = await cache.match(cacheKey);
          if (cached) return withCors(cached, cors, "HIT-STALE");
          return json(
            { ok: false, error: "opensky_upstream_error", status: res.status, detail: text.slice(0, 220) },
            502,
            cors
          );
        }

        const out = new Response(text, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=2, s-maxage=5, stale-while-revalidate=25",
          },
        });

        ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      } catch (err) {
        // Timeout / network failure: fall back to cached response if present
        const cached = await cache.match(cacheKey);
        if (cached) return withCors(cached, cors, "HIT-STALE");

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

// -------------------- OpenSky Helpers --------------------

async function openskyHealth(env, cors) {
  const mode = detectOpenSkyAuthMode(env);

  // tiny bbox (reduces load and improves responsiveness)
  const upstream = new URL(OPENSKY_STATES_URL);
  upstream.searchParams.set("lamin", "36.05");
  upstream.searchParams.set("lomin", "-94.20");
  upstream.searchParams.set("lamax", "36.25");
  upstream.searchParams.set("lomax", "-93.95");

  try {
    const headers = await buildOpenSkyHeaders(env);
    const res = await fetchWithTimeout(upstream.toString(), { method: "GET", headers }, 9000);

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

    return json(
      {
        ok: true,
        authMode: mode,
        openskyStatus: res.status,
        rateRemaining,
        tokenCached: _tokenCache.mode === "oauth" ? (_tokenCache.expiresAtMs > Date.now()) : null,
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

  // OAuth2 (recommended)
  if (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) {
    const token = await getOAuthToken(env);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      return headers;
    }
  }

  // Legacy Basic Auth fallback
  if (env.OPENSKY_USER && env.OPENSKY_PASS) {
    const token = btoa(`${env.OPENSKY_USER}:${env.OPENSKY_PASS}`);
    headers.Authorization = `Basic ${token}`;
  }

  return headers;
}

async function getOAuthToken(env) {
  const now = Date.now();
  if (_tokenCache.mode === "oauth" && _tokenCache.accessToken && _tokenCache.expiresAtMs > now + 10_000) {
    return _tokenCache.accessToken;
  }

  if (_tokenPromise) return _tokenPromise;

  _tokenPromise = (async () => {
    try {
      const clientId = String(env.OPENSKY_CLIENT_ID || "").trim();
      const clientSecret = String(env.OPENSKY_CLIENT_SECRET || "").trim();
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
        9000
      );

      const text = await res.text();
      if (!res.ok) {
        clearTokenCache();
        return "";
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        clearTokenCache();
        return "";
      }

      const accessToken = String(data?.access_token || "").trim();
      const expiresInSec = Number(data?.expires_in || 1800);

      if (!accessToken) {
        clearTokenCache();
        return "";
      }

      // refresh early by 60s to avoid edge-of-expiry 401s
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