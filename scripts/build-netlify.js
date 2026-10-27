// Assembles the Netlify publish directory. Copying an explicit allowlist keeps .env, node_modules and
// data/live-events.json out of the deploy.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });

const files = ["index.html", "vendor/posthog.js", "data/stats-snapshot.json", ".nojekyll"];
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(dist, f)), { recursive: true });
  fs.copyFileSync(path.join(root, f), path.join(dist, f));
}
console.log(`dist/ ready: ${files.join(", ")}`);
