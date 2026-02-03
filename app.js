
/* FlightWall app.js v133 */
(function(){
  const ORIGIN = location.origin;
  let lastHex = null, stableSince = 0;

  async function j(p){ const r = await fetch(ORIGIN+p); return r.ok ? r.json() : null; }

  window.updatePrimaryFlight = async f => {
    if (!f || !f.icao24) return;
    const now = Date.now();
    if (f.icao24 !== lastHex){ lastHex=f.icao24; stableSince=now; return; }
    if (now-stableSince<5000) return;

    const ac = await j(`/aircraft/icao24/${f.icao24}`);
    if (ac?.model) document.getElementById("model").textContent = ac.model;

    if (f.callsign){
      const rt = await j(`/aero/${f.callsign}`);
      if (rt?.origin && rt?.destination){
        document.getElementById("route").textContent =
          `${rt.origin.iata||""} → ${rt.destination.iata||""}`;
      }
    }
  };
})();
