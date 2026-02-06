Cloudflare Worker API

Set variables/secrets:
- AERODATA_HOST (vars)  = aerodatabox.p.rapidapi.com
- AERODATA_KEY  (secret)
Optional:
- OPENSKY_USER (secret)
- OPENSKY_PASS (secret)

Endpoints:
- /health
- /opensky/states?lamin&lomin&lamax&lomax
- /flight/<CALLSIGN>
- /aircraft/icao24/<HEX>
