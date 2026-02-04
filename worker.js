/**
 * FlightsAbove Worker
 * Version: v158
 *
 * Deployment sanity-check build.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        ts: new Date().toISOString(),
        version: "v158"
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>FlightsAbove</title>
  <style>
    body { font-family: system-ui, sans-serif; background:#0b1220; color:#fff; padding:20px; }
    .ver { position:fixed; bottom:10px; right:10px; opacity:.6; font-size:12px; }
  </style>
</head>
<body>
  <h1>FlightsAbove</h1>
  <p>Worker deployed successfully.</p>
  <div class="ver">v158</div>
</body>
</html>
      `, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/html; charset=utf-8"
        }
      });
    }

    return new Response("FlightsAbove worker v158", {
      status: 200,
      headers: corsHeaders
    });
  }
};
