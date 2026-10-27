const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleApi, MAX_BODY_BYTES } = require("./lib/api.js");

const PORT = Number(process.env.PORT || 8796);
const LIVE_EVENTS_PATH = path.join(__dirname, "data", "live-events.json");

// The local server keeps recent validated events on disk so a stats refresh sees them before PostHog's
// ClickHouse ingestion catches up. Serverless hosting (Netlify) has no such store; see netlify/functions/api.js.
const fileStore = {
  load() {
    try {
      if (!fs.existsSync(LIVE_EVENTS_PATH)) return [];
      return JSON.parse(fs.readFileSync(LIVE_EVENTS_PATH, "utf8"));
    } catch {
      return [];
    }
  },
  save(ev) {
    const list = this.load();
    list.push(ev);
    while (list.length > 500) list.shift();
    fs.mkdirSync(path.dirname(LIVE_EVENTS_PATH), { recursive: true });
    fs.writeFileSync(LIVE_EVENTS_PATH, JSON.stringify(list, null, 2));
  },
};

// Re-read on every request, like before, so editing .env needs no restart.
function readEnv() {
  const env = { ...process.env };
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return env;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES * 2) { req.destroy(); return reject(new Error("payload too large")); }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      const bodyText = req.method === "POST" ? await readBody(req) : "";
      const out = await handleApi({ method: req.method, pathname: url.pathname, query: url.searchParams, bodyText, env: readEnv(), store: fileStore });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/vendor/posthog.js") {
      const phBundle = path.join(__dirname, "node_modules", "posthog-js", "dist", "array.no-external.js");
      const content = fs.readFileSync(phBundle);
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(content);
      return;
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26"><rect x="1" y="1" width="24" height="24" rx="5" fill="#141413"/><rect x="6" y="14" width="3" height="6" rx="1" fill="#F7F5F0"/><rect x="11.5" y="10" width="3" height="10" rx="1" fill="#F7F5F0"/><rect x="17" y="6" width="3" height="14" rx="1" fill="#FF4F00"/></svg>`;
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      res.end(svg);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const htmlPath = path.join(__dirname, "serve", "index.html");
      const content = fs.readFileSync(htmlPath);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(content);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error("Server error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Handbook Signal server listening on http://127.0.0.1:${PORT}`);
});
