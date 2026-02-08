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
 * Fallback provider (NEW):
 *  - ADSB.lol drop-in API for ADSBExchange-style endpoints
 *  - Set ADSBLOL_BASE (Text) if you want to override. Default: https://api.adsb.lol
 *
 * Stability goals:
 *  - Longer OpenSky timeout (cellular/routing can be slower)
 *  - Cache last-known-good states per bbox + auth mode
 *  - Serve cached states if OpenSky times out (prevents blank UI)
 *  - If OpenSky returns 429 or times out, try ADSB.lol fallback
 */

const WORKER_VERSION = "v171";

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

// Timeouts: token fast, states longer (OpenSky can be slow on some routes)
const OPENSKY_TOKEN_TIMEOUT_MS = 9000;
const OPENSKY_STATES_TIMEOUT_MS = 18000;

// Fallback timeout (keep it snappy)
const FALLBACK_TIMEOUT_MS = 12000;

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

    // ---- OpenSky States (with ADSB.lol fallback) ----
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

      // Helper to return cached if available
      const tryCached = async (hint) => {
        const cached = await cache.match(cacheKey);
        if (cached) return withCors(cached, cors, hint || "HIT-STALE");
        return null;
      };

      try {
        const headers = await buildOpenSkyHeaders(env);

        const res = await fetchWithTimeout(
          upstream.toString(),
          { method: "GET", headers },
          OPENSKY_STATES_TIMEOUT_MS
        );

        // If unauthorized and we used OAuth, clear token and retry once
        if (!res.ok && res.status === 401 && _tokenCache.mode === "oauth") {
          const text401 = await res.text();
          clearTokenCache();

          const headers2 = await buildOpenSkyHeaders(env);
          const res2 = await fetchWithTimeout(
            upstream.toString(),
            { method: "GET", headers: headers2 },
            OPENSKY_STATES_TIMEOUT_MS
          );

          if (!res2.ok) {
            // If 429 or other upstream errors, try fallback before cached
            if (res2.status === 429) {
              const fb = await tryAdsbLolFallback({ lamin, lomin, lamax, lomax }, env);
              if (fb) {
                const outFb = new Response(JSON.stringify(fb), {
                  status: 200,
                  headers: {
                    ...cors,
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
                    "X-Upstream": "adsb.lol",
                  },
                });
                ctx.waitUntil(cache.put(cacheKey, outFb.clone()));
                return outFb;
              }
            }

            const cached = await tryCached("HIT-STALE");
            if (cached) return cached;

            const text2 = await res2.text();
            return json(
              {
                ok: false,
                error: "opensky_upstream_error",
                status: res2.status,
                detail: text2.slice(0, 220),
                note: text401 ? `first_401: ${text401.slice(0, 120)}` : undefined,
              },
              502,
              cors
            );
          }

          const text2 = await res2.text();
          const out2 = new Response(text2, {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
              "X-Upstream": "opensky",
            },
          });

          ctx.waitUntil(cache.put(cacheKey, out2.clone()));
          return out2;
        }

        // If OpenSky is rate-limiting, try ADSB.lol fallback immediately
        if (!res.ok && res.status === 429) {
          const fb = await tryAdsbLolFallback({ lamin, lomin, lamax, lomax }, env);
          if (fb) {
            const outFb = new Response(JSON.stringify(fb), {
              status: 200,
              headers: {
                ...cors,
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
                "X-Upstream": "adsb.lol",
              },
            });
            ctx.waitUntil(cache.put(cacheKey, outFb.clone()));
            return outFb;
          }

          const cached = await tryCached("HIT-STALE");
          if (cached) return cached;

          const text429 = await res.text();
          return json(
            { ok: false, error: "opensky_upstream_error", status: res.status, detail: text429.slice(0, 220) },
            502,
            cors
          );
        }

        // Other non-OK OpenSky errors
        if (!res.ok) {
          const cached = await tryCached("HIT-STALE");
          if (cached) return cached;

          const text = await res.text();
          return json(
            { ok: false, error: "opensky_upstream_error", status: res.status, detail: text.slice(0, 220) },
            502,
            cors
          );
        }

        // Success: cache and return
        const text = await res.text();
        const out = new Response(text, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
            "X-Upstream": "opensky",
          },
        });

        ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      } catch (err) {
        // Timeout / network failure: try ADSB.lol fallback first
        const fb = await tryAdsbLolFallback({ lamin, lomin, lamax, lomax }, env);
        if (fb) {
          const outFb = new Response(JSON.stringify(fb), {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=8, s-maxage=15, stale-while-revalidate=45",
              "X-Upstream": "adsb.lol",
            },
          });
          ctx.waitUntil(caches.default.put(cacheKey, outFb.clone()));
          return outFb;
        }

        // Fall back to cached response if present
        const cached = await caches.default.match(cacheKey);
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

    return new Response("FlightsAboveMe API worker", { status: 200, headers: cors });
  },
};

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

// -------------------- ADSB.lol Fallback --------------------

async function tryAdsbLolFallback(bbox, env) {
  // ADSB.lol API is described as a drop-in replacement for ADSBExchange-style endpoints.  [oai_citation:0‡GitHub](https://github.com/adsblol/api?utm_source=chatgpt.com)
  // We use the ADSBExchange REST endpoint shape: /api/aircraft/lat/{lat}/lon/{lon}/dist/{dist}/ (100NM max).  [oai_citation:1‡ADS-B Exchange](https://www.adsbexchange.com/data/rest-api-samples/)
  try {
    const base = (env.ADSBLOL_BASE ? String(env.ADSBLOL_BASE) : "https://api.adsb.lol").trim().replace(/\/+$/, "");
    if (!base) return null;

    const lamin = Number(bbox.lamin);
    const lomin = Number(bbox.lomin);
    const lamax = Number(bbox.lamax);
    const lomax = Number(bbox.lomax);
    if (![lamin, lomin, lamax, lomax].every((n) => Number.isFinite(n))) return null;

    // Center point from bbox
    const clat = (lamin + lamax) / 2;
    const clon = (lomin + lomax) / 2;

    // Radius to far corner (miles->NM), cap at 100 NM
    const cornerLat = lamax;
    const cornerLon = lomax;
    const miles = haversineMi(clat, clon, cornerLat, cornerLon);
    const nm = Math.min(100, Math.max(5, miles / 1.15078));
    const distNm = Math.round(nm);

    const fbUrl = `${base}/api/aircraft/lat/${encodeURIComponent(clat.toFixed(4))}/lon/${encodeURIComponent(
      clon.toFixed(4)
    )}/dist/${encodeURIComponent(distNm)}/`;

    const res = await fetchWithTimeout(fbUrl, { method: "GET", headers: { Accept: "application/json" } }, FALLBACK_TIMEOUT_MS);
    if (!res.ok) return null;

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }

    // ADSBExchange-style response is typically { ac: [...] } (as referenced in their examples).  [oai_citation:2‡ADS-B Exchange](https://www.adsbexchange.com/data/rest-api-samples/)
    const list =
      (Array.isArray(data?.ac) && data.ac) ||
      (Array.isArray(data?.aircraft) && data.aircraft) ||
      (Array.isArray(data?.aircrafts) && data.aircrafts) ||
      [];

    const nowSec = Math.floor(Date.now() / 1000);

    const states = list.map((a) => {
      // Try to support both "old" and "v2 aircraft.json" style keys.
      const hex = nm(a?.hex || a?.icao || a?.Icao || a?.icao24 || a?.transponder || "").toLowerCase().replace(/^~/, "");
      const callsign = nm(a?.flight || a?.call || a?.callsign || a?.cs || "");
      const lat = toNum(a?.lat ?? a?.Lat ?? a?.latitude);
      const lon = toNum(a?.lon ?? a?.Lon ?? a?.longitude);

      // alt: v2 uses alt_baro in feet or "ground"; older often "alt" in feet
      let altFt = null;
      const altRaw = a?.alt_baro ?? a?.alt ?? a?.Alt ?? a?.altitude;
      if (typeof altRaw === "string" && altRaw.toLowerCase() === "ground") altFt = 0;
      else altFt = toNum(altRaw);

      // speed: v2 uses gs in knots, older often spd in knots
      const gsKt = toNum(a?.gs ?? a?.spd ?? a?.Spd ?? a?.speed);

      // track: v2 uses track, older uses trak
      const track = toNum(a?.track ?? a?.trak ?? a?.Trak);

      // vertical rate: v2 baro_rate in fpm, older may have "vrt"
      const vrFpm = toNum(a?.baro_rate ?? a?.geom_rate ?? a?.vrt ?? a?.Vrt);

      // squawk
      const squawk = nm(a?.squawk ?? a?.Squawk ?? "");

      // Basic conversions to OpenSky schema:
      // - OpenSky expects alt in meters, velocity in m/s, vertical_rate in m/s
      const baroAltM = Number.isFinite(altFt) ? altFt / 3.28084 : null;
      const velMs = Number.isFinite(gsKt) ? gsKt * 0.514444 : null;
      const vrMs = Number.isFinite(vrFpm) ? (vrFpm / 196.850394) : null; // fpm -> m/s

      const onGround = (typeof altRaw === "string" && altRaw.toLowerCase() === "ground") ? true : false;

      // time_position / last_contact: use "now - seen_pos" if available, else now
      const seenPos = toNum(a?.seen_pos);
      const lastContact = Number.isFinite(seenPos) ? Math.max(0, nowSec - Math.round(seenPos)) : nowSec;

      return [
        hex || "",                 // 0: icao24
        padCallsign8(callsign),    // 1: callsign (OpenSky often padded)
        "—",                       // 2: origin_country (unknown here; UI treats US as "—" anyway)
        lastContact,               // 3: time_position
        lastContact,               // 4: last_contact
        Number.isFinite(lon) ? lon : null, // 5: longitude
        Number.isFinite(lat) ? lat : null, // 6: latitude
        Number.isFinite(baroAltM) ? baroAltM : null, // 7: baro_altitude (m)
        !!onGround,                // 8: on_ground
        Number.isFinite(velMs) ? velMs : null,       // 9: velocity (m/s)
        Number.isFinite(track) ? track : null,       // 10: true_track
        Number.isFinite(vrMs) ? vrMs : null,         // 11: vertical_rate (m/s)
        null,                      // 12: sensors
        null,                      // 13: geo_altitude
        squawk || null,            // 14: squawk
        false,                     // 15: spi
        0                          // 16: position_source (0 unknown)
      ];
    }).filter((s) => s && s[0] && Number.isFinite(s[5]) && Number.isFinite(s[6]));

    return {
      time: nowSec,
      states
    };
  } catch {
    return null;
  }
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

function nm(s) {
  return (s ?? "").toString().trim();
}

function toNum(v) {
  const n = (typeof v === "number") ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : NaN;
}

function padCallsign8(cs) {
  const c = nm(cs);
  if (!c) return "";
  // OpenSky commonly uses 8 chars padded with spaces
  return (c.length >= 8) ? c.slice(0, 8) : (c + "        ").slice(0, 8);
}

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.7613;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}