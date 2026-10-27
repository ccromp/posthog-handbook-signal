// Netlify Function adapter: every /api/* request (see netlify.toml) runs the same handler as the local server.
// The personal API key is read from the site's server-side environment; no event store is passed because the
// function filesystem is ephemeral, so /api/event-sync only validates and /api/stats is pure live HogQL.
const { handleApi } = require("../../lib/api.js");

exports.handler = async event => {
  const url = new URL(event.rawUrl || `https://localhost${event.path}${event.rawQuery ? "?" + event.rawQuery : ""}`);
  const bodyText = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  const out = await handleApi({
    method: event.httpMethod,
    pathname: url.pathname,
    query: url.searchParams,
    bodyText,
    env: process.env,
    store: null,
  });
  return { statusCode: out.status, headers: out.headers, body: out.body };
};
