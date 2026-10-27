// Captures data/stats-snapshot.json from a running `node server.js`, so the static site (GitHub Pages)
// can show the last PostHog Cloud numbers when there is no backend. Contains only public client config
// and aggregated usage; the personal API key never leaves the server.
const fs = require("fs");
const path = require("path");

const base = `http://127.0.0.1:${process.env.PORT || 8796}`;
const getJson = async p => {
  const r = await fetch(base + p);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};

(async () => {
  const [config, stats] = await Promise.all([getJson("/api/config"), getJson("/api/stats")]);
  const out = { ...stats, source: "snapshot", capturedAt: new Date().toISOString(), config };
  fs.writeFileSync(path.join(__dirname, "data", "stats-snapshot.json"), JSON.stringify(out));
  console.log(`Wrote data/stats-snapshot.json (${Object.keys(out.data).length} pages)`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
