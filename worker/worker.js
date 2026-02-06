/**
 * FlightWall API Worker (v168)
 *
 * Endpoints:
 *  - GET /health
 *  - GET /opensky/states?lamin&lomin&lamax&lomax (bbox required)
 *  - GET /flight/<CALLSIGN> (AeroDataBox callsign lookup)
 *  - GET /aircraft/icao24/<HEX> (AeroDataBox aircraft lookup)
 */

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
      return json({ ok: true, ts: new Date().toISOString(), version: "v168" }, 200, cors);
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "opensky" && parts[1] === "states") {
      const lamin = url.searchParams.get("lamin");
      const lomin = url.searchParams.get("lomin");
      const lamax = url.searchParams.get("lamax");
      const lomax = url.searchParams.get("lomax");

      if (!lamin || !lomin || !lamax || !lomax) {
        return json({ ok:false, error:"missing bbox params", hint:"lamin,lomin,lamax,lomax required" }, 400, cors);
      }

      const upstream = new URL("https://opensky-network.org/api/states/all");
      upstream.searchParams.set("lamin", lamin);
      upstream.searchParams.set("lomin", lomin);
      upstream.searchParams.set("lamax", lamax);
      upstream.searchParams.set("lomax", lomax);

      const headers = { "Accept": "application/json" };
      if (env.OPENSKY_USER && env.OPENSKY_PASS) {
        const token = btoa(`${env.OPENSKY_USER}:${env.OPENSKY_PASS}`);
        headers["Authorization"] = `Basic ${token}`;
      }

      try {
        const res = await fetch(upstream.toString(), { method:"GET", headers });
        const text = await res.text();
        if (!res.ok) {
          return json({ ok:false, error:"opensky_upstream_error", status: res.status, detail: text.slice(0,220) }, 502, cors);
        }
        return new Response(text, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=2, s-maxage=5"
          }
        });
      } catch (err) {
        return json({ ok:false, error:"opensky_fetch_failed", detail: (err && err.message) ? err.message : "unknown" }, 502, cors);
      }
    }

    if (parts[0] === "flight" && parts[1]) {
      const callsign = parts[1].trim().toUpperCase().replace(/\s+/g,"");
      if (!callsign) return json({ ok:false, error:"missing callsign" }, 400, cors);
      if (!env.AERODATA_KEY || !env.AERODATA_HOST) {
        return json({ ok:false, error:"aerodata_not_configured", hint:"Set AERODATA_KEY (Secret) and AERODATA_HOST (Text)" }, 500, cors);
      }

      const upstreamUrl = `https://${env.AERODATA_HOST}/flights/callsign/${encodeURIComponent(callsign)}`;
      try {
        const res = await fetch(upstreamUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "X-RapidAPI-Key": String(env.AERODATA_KEY),
            "X-RapidAPI-Host": String(env.AERODATA_HOST),
          }
        });

        const text = await res.text();
        if (res.status === 429) return json({ ok:false, callsign, error:"rate_limited", status:429 }, 429, cors);
        if (!res.ok) return json({ ok:false, callsign, error:"aerodata_upstream_error", status:res.status, detail:text.slice(0,220) }, 502, cors);

        let data;
        try { data = JSON.parse(text); } catch { return json({ ok:false, callsign, error:"aerodata_non_json" }, 502, cors); }
        const f = Array.isArray(data) ? data[0] : data;
        const origin = f?.departure?.airport || null;
        const destination = f?.arrival?.airport || null;

        return new Response(JSON.stringify({
          ok: true,
          callsign,
          origin,
          destination,
          airlineName: f?.airline?.name || f?.airline?.shortName || null,
          aircraftModel: f?.aircraft?.model || f?.aircraft?.modelCode || null,
          aircraftType: f?.aircraft?.typeName || f?.aircraft?.iataCodeShort || f?.aircraft?.icaoCode || null,
          route: (origin && destination) ? `${fmtEnd(origin)} → ${fmtEnd(destination)}` : "unavailable",
          source: "aerodatabox"
        }), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=30, s-maxage=300"
          }
        });
      } catch (err) {
        return json({ ok:false, callsign, error:"aerodata_fetch_failed", detail:(err&&err.message)?err.message:"unknown" }, 502, cors);
      }
    }

    if (parts[0] === "aircraft" && parts[1] === "icao24" && parts[2]) {
      const hex = parts[2].trim().toLowerCase();
      if (!hex) return json({ ok:false, error:"missing icao24" }, 400, cors);
      if (!env.AERODATA_KEY || !env.AERODATA_HOST) {
        return json({ ok:false, error:"aerodata_not_configured", hint:"Set AERODATA_KEY (Secret) and AERODATA_HOST (Text)" }, 500, cors);
      }

      const upstreamUrl = `https://${env.AERODATA_HOST}/aircrafts/icao24/${encodeURIComponent(hex)}`;
      try {
        const res = await fetch(upstreamUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "X-RapidAPI-Key": String(env.AERODATA_KEY),
            "X-RapidAPI-Host": String(env.AERODATA_HOST),
          }
        });

        if (res.status === 204) {
          return new Response(JSON.stringify({ ok:true, found:false, icao24: hex }), {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=30, s-maxage=600" }
          });
        }

        const text = await res.text();
        if (res.status === 429) return json({ ok:false, icao24: hex, error:"rate_limited", status:429 }, 429, cors);
        if (!res.ok) return json({ ok:false, icao24: hex, error:"aerodata_upstream_error", status:res.status, detail:text.slice(0,220) }, 502, cors);

        return new Response(text, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=3600, s-maxage=21600"
          }
        });
      } catch (err) {
        return json({ ok:false, icao24: hex, error:"aerodata_fetch_failed", detail:(err&&err.message)?err.message:"unknown" }, 502, cors);
      }
    }

    return new Response("FlightWall API worker", { status: 200, headers: cors });
  }
};

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function fmtEnd(airport){
  if (!airport || typeof airport !== "object") return "";
  const city = (airport.municipalityName || airport.city || "").toString().trim().replace(/\/+\s*$/,"");
  const code = (airport.iata || airport.icao || "").toString().trim();
  const name = (airport.name || "").toString().trim();
  const bestCity = city || (name ? name.split(" ")[0] : "");
  if (bestCity && code) return `${bestCity} (${code})`;
  return bestCity || code || "";
}
