// Cloudflare Worker - Flights Above Me
export default {
  async fetch(request, env) {
    return new Response("Flights Above Me worker running", { status: 200 });
  }
};
