// v174 Tier A/B logic
const tierToggle = document.getElementById("tierBToggle");

function isTierA(f) {
  if (!f) return false;
  const cs = (f.callsign || "").trim();
  if (/[A-Z]/i.test(cs)) return true;
  const op = (f.airlineCode || "").toUpperCase();
  return ["AAL","DAL","UAL","SWA","UPS","FDX","ASA","FFT","JBU","NKS"].includes(op);
}

function selectMain(flights) {
  const allowTierB = tierToggle.checked;
  const eligible = allowTierB ? flights : flights.filter(isTierA);
  return eligible[0] || flights[0] || null;
}

// placeholder render loop
console.log("FlightWall v174 loaded");
