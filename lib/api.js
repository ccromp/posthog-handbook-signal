// Transport-agnostic /api/* implementation shared by the local Node server (server.js) and the Netlify
// function (netlify/functions/api.js). It never touches the filesystem: persistence of recent events is an
// optional `store` ({ load(): event[], save(ev) }) that only the local server provides.
const { DOCS, REPS, dp, distinctId, generateBaselineData } = require("../seed-generator.js");

const docByPath = new Map();
const docById = new Map();
DOCS.forEach(d => {
  docByPath.set(dp(d), d);
  docByPath.set(d.path, d);
  docById.set(d.id, d);
});

const repByDistinctId = new Map();
REPS.forEach(r => {
  repByDistinctId.set(distinctId(r), r);
  repByDistinctId.set(r.id, r);
});

const TEAM_NAMES = {
  "sales-cs": "Sales & CS",
  "wizard-and-docs": "Wizard & Docs",
  "forward-deployed-engineering": "Forward Deployed Engineering",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Cache-Control, Pragma",
  "Access-Control-Max-Age": "86400",
};

const ALLOWED_EVENTS = new Set(["$pageview", "enablement_engaged_read", "enablement_page_left", "enablement_section_viewed", "survey sent"]);
const SURVEY_ANSWERS = new Set(["Yes", "Partly", "No"]);
const MAX_BODY_BYTES = 8 * 1024;
const MAX_NOTE = 500;
const MAX_STR = 200;

function cleanMarkdown(raw) {
  let body = String(raw || "");
  const fmMatch = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (fmMatch) {
    body = body.slice(fmMatch[0].length);
  }
  body = body.replace(/<PrivateLink\s+url=(["'])([^"']+)\1\s*>([\s\S]*?)<\/PrivateLink>/g, '[$3]($2 "Internal link")');
  body = body.replace(/<SmallTeam\s+slug=(["'])([^"']+)\1\s*\/>/g, (_, q, slug) =>
    TEAM_NAMES[slug] || slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
  );
  body = body.replace(/<TeamMember\s+name=(["'])([^"']+)\1[^>]*\/>/g, "$2");
  body = body.replace(/<\/?CalloutBox[^>]*>/g, "");
  body = body.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => `[Image: ${alt || "screenshot"}](${url})`);
  return body.trim();
}

// Best-effort per-instance cache; correctness never depends on it (a serverless cold start just refetches).
const liveDocCache = new Map();
const LIVE_DOC_TTL_MS = 10 * 60 * 1000;

async function fetchLiveDocFromGitHub(doc, forceRefresh = false) {
  const cached = liveDocCache.get(doc.id);
  if (!forceRefresh && cached && Date.now() - cached.ts < LIVE_DOC_TTL_MS) {
    return { ...cached.payload, cached: true };
  }
  const githubRawUrl = `https://raw.githubusercontent.com/PostHog/posthog.com/master/${doc.path}`;
  const githubBlobUrl = `https://github.com/PostHog/posthog.com/blob/master/${doc.path}`;
  const canonicalUrl = `https://posthog.com${doc.url}`;
  const res = await fetch(githubRawUrl, {
    headers: { "User-Agent": "Handbook-Signal-Telemetry-PoC/1.0" },
  });
  if (!res.ok) {
    throw new Error(`GitHub raw fetch failed (${res.status}) for ${doc.path}`);
  }
  const rawMd = await res.text();
  const md = cleanMarkdown(rawMd);
  const payload = {
    id: doc.id,
    title: doc.title,
    cat: doc.cat,
    path: doc.path,
    url: doc.url,
    canonicalUrl,
    githubBlobUrl,
    githubRawUrl,
    source: "github.com/PostHog/posthog.com (live)",
    fetchedAt: new Date().toISOString(),
    cached: false,
    md,
  };
  liveDocCache.set(doc.id, { ts: Date.now(), payload });
  return payload;
}

function readEnv(env) {
  return {
    apiHost: (env.POSTHOG_API_HOST || "https://us.posthog.com").replace(/\/$/, ""),
    ingestHost: (env.POSTHOG_INGEST_HOST || "https://us.i.posthog.com").replace(/\/$/, ""),
    projectId: env.POSTHOG_PROJECT_ID || "",
    projectToken: env.POSTHOG_PROJECT_TOKEN || "",
    personalKey: env.POSTHOG_PERSONAL_API_KEY || "",
    surveyId: env.POSTHOG_SURVEY_ID || "",
  };
}

// PostHog ties `survey sent` events to a survey by its UUID, not its name.
// Use POSTHOG_SURVEY_ID if set, else look the survey up by name (cached per project).
// Returns null when it cannot be resolved: the UI then refuses to send survey answers rather than send the name.
const SURVEY_NAME = "enablement-helpful";
let surveyIdCache = null;
async function resolveSurveyId(cfg) {
  const { apiHost, projectId, personalKey, surveyId } = cfg;
  if (surveyId) return surveyId;
  if (!projectId || !personalKey) return null;
  if (surveyIdCache && surveyIdCache.projectId === projectId) return surveyIdCache.id;
  try {
    const res = await fetch(`${apiHost}/api/projects/${projectId}/surveys/`, { headers: { Authorization: `Bearer ${personalKey}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const found = ((await res.json()).results || []).find(sv => sv.name === SURVEY_NAME);
    if (!found) throw new Error(`no survey named ${SURVEY_NAME} in project ${projectId}`);
    surveyIdCache = { projectId, id: found.id };
    return found.id;
  } catch (e) {
    console.warn("Could not resolve survey UUID:", String(e.message || e));
    return null;
  }
}

async function hogql(apiHost, projectId, personalKey, query) {
  const res = await fetch(`${apiHost}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${personalKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HogQL HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

function emptyStatsStructures() {
  const DATA = {};
  const SURVEY = {};
  const MISSING = {};
  DOCS.forEach(d => {
    DATA[d.id] = {};
    REPS.forEach(r => {
      DATA[d.id][r.id] = { views: 0, engaged: 0, dwell: 0, last: null };
    });
    SURVEY[d.id] = { yes: 0, partly: 0, no: 0, mine: {} };
  });
  return { DATA, SURVEY, MISSING };
}

function applyEventToStats(ev, DATA, SURVEY, MISSING) {
  const props = ev.properties || {};
  const docPath = props.doc_path;
  const doc = docByPath.get(docPath) || DOCS.find(d => d.id === props.doc_id);
  if (!doc) return;
  const rep = repByDistinctId.get(ev.distinct_id) || repByDistinctId.get(props.rep_id) || REPS[0];
  const rec = DATA[doc.id]?.[rep.id];

  if (ev.event === "$pageview" && rec) {
    rec.views += 1;
    rec.last = 0;
  } else if (ev.event === "enablement_engaged_read" && rec) {
    rec.engaged += 1;
  } else if (ev.event === "enablement_page_left" && rec) {
    rec.dwell += Number(props.dwell_seconds || 0);
  } else if (ev.event === "survey sent") {
    const ans = props.$survey_response;
    if (!SURVEY_ANSWERS.has(ans)) return;
    const note = String(props.$survey_response_1 || "").trim().slice(0, MAX_NOTE);
    const sv = SURVEY[doc.id];
    if (sv) {
      if (ans === "Yes") sv.yes += 1;
      else if (ans === "Partly") sv.partly += 1;
      else sv.no += 1;
      if (!props.seeded) {
        sv.mine[rep.id] = ans;
      }
    }
    if (note) {
      MISSING[doc.id] = MISSING[doc.id] || [];
      if (!MISSING[doc.id].some(m => m.rep === rep.id && m.text === note)) {
        MISSING[doc.id].unshift({ rep: rep.id, text: note });
      }
    }
  }
}

const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);

// Validates and normalises an /api/event-sync payload. Returns { ok: true, event } with a whitelist-picked copy
// (unknown properties dropped) or { ok: false, error }.
function validateEvent(ev) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return { ok: false, error: "body must be a JSON object" };
  if (typeof ev.event !== "string" || !ALLOWED_EVENTS.has(ev.event)) return { ok: false, error: "event not allowed" };
  if (typeof ev.distinct_id !== "string" || !repByDistinctId.has(ev.distinct_id)) return { ok: false, error: "unknown distinct_id" };
  const p = ev.properties;
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "properties must be an object" };
  const doc = typeof p.doc_path === "string" ? docByPath.get(p.doc_path) : null;
  if (!doc) return { ok: false, error: "unknown doc_path" };
  const syncId = str(p.ph_sync_id, MAX_STR);
  if (!syncId) return { ok: false, error: "ph_sync_id required (string, max 200)" };
  const props = { doc_path: p.doc_path, ph_sync_id: syncId };
  if (p.rep_id !== undefined) {
    if (typeof p.rep_id !== "string" || !repByDistinctId.has(p.rep_id)) return { ok: false, error: "unknown rep_id" };
    props.rep_id = p.rep_id;
  }
  if (ev.event === "enablement_page_left") {
    const secs = Number(p.dwell_seconds);
    if (!Number.isFinite(secs) || secs < 0 || secs > 86400) return { ok: false, error: "dwell_seconds out of range" };
    props.dwell_seconds = secs;
  }
  if (ev.event === "survey sent") {
    if (typeof p.$survey_response !== "string" || !SURVEY_ANSWERS.has(p.$survey_response)) {
      return { ok: false, error: "$survey_response must be Yes, Partly or No" };
    }
    props.$survey_response = p.$survey_response;
    if (p.$survey_response_1 !== undefined) {
      if (typeof p.$survey_response_1 !== "string" || p.$survey_response_1.length > MAX_NOTE) {
        return { ok: false, error: `$survey_response_1 must be a string of at most ${MAX_NOTE} characters` };
      }
      props.$survey_response_1 = p.$survey_response_1;
    }
    for (const k of ["$survey_id", "$survey_name"]) {
      if (p[k] !== undefined) {
        const v = str(p[k], MAX_STR);
        if (v === null) return { ok: false, error: `${k} must be a string of at most ${MAX_STR} characters` };
        props[k] = v;
      }
    }
  }
  return { ok: true, event: { event: ev.event, distinct_id: ev.distinct_id, properties: props } };
}

async function fetchPostHogStats(env, store) {
  const { apiHost, projectId, personalKey } = readEnv(env);
  const recent = () => (store ? store.load() : []);
  if (!projectId || !personalKey) {
    const { DATA, SURVEY, MISSING } = generateBaselineData();
    for (const ev of recent()) applyEventToStats(ev, DATA, SURVEY, MISSING);
    return { data: DATA, survey: SURVEY, missing: MISSING, source: "fallback-unconfigured", projectId: null };
  }

  const [usageRes, surveyRes] = await Promise.all([
    hogql(
      apiHost,
      projectId,
      personalKey,
      `SELECT
         properties.doc_path AS doc_path,
         distinct_id,
         countIf(event = '$pageview') AS views,
         countIf(event = 'enablement_engaged_read') AS engaged,
         sumIf(toFloatOrZero(toString(properties.dwell_seconds)), event = 'enablement_page_left') AS dwell,
         dateDiff('day', maxIf(timestamp, event = '$pageview'), now()) AS last_days,
         groupArrayIf(toString(properties.ph_sync_id), properties.ph_sync_id IS NOT NULL) AS sync_ids
       FROM events
       WHERE timestamp >= now() - INTERVAL 30 DAY
         AND event IN ('$pageview', 'enablement_engaged_read', 'enablement_page_left')
         AND properties.doc_path IS NOT NULL
       GROUP BY doc_path, distinct_id
       LIMIT 10000`
    ),
    hogql(
      apiHost,
      projectId,
      personalKey,
      `SELECT
         properties.doc_path AS doc_path,
         distinct_id,
         toString(properties.$survey_response) AS response,
         toString(properties.$survey_response_1) AS note,
         toString(properties.seeded) = 'true' AS is_seeded,
         toString(properties.ph_sync_id) AS sync_id,
         timestamp
       FROM events
       WHERE timestamp >= now() - INTERVAL 30 DAY
         AND event = 'survey sent'
         AND properties.doc_path IS NOT NULL
       ORDER BY timestamp ASC
       LIMIT 10000`
    ),
  ]);

  const { DATA, SURVEY, MISSING } = emptyStatsStructures();
  const ingestedSyncIds = new Set();

  for (const row of usageRes.results || []) {
    const [docPath, distId, viewsRaw, engagedRaw, dwellRaw, lastDaysRaw, syncIds] = row;
    const doc = docByPath.get(docPath);
    const rep = repByDistinctId.get(distId);
    if (Array.isArray(syncIds)) {
      syncIds.forEach(id => { if (id) ingestedSyncIds.add(String(id)); });
    }
    if (!doc || !rep) continue;
    const views = Number(viewsRaw || 0);
    const engaged = Number(engagedRaw || 0);
    const rawDwell = Math.round(Number(dwellRaw || 0));
    const dwell = Math.max(rawDwell, engaged * 30);
    const last = views > 0 ? Math.max(0, Number(lastDaysRaw || 0)) : null;
    DATA[doc.id][rep.id] = { views, engaged, dwell, last };
  }

  for (const row of surveyRes.results || []) {
    const [docPath, distId, ans, noteRaw, seededRaw, syncId] = row;
    const seeded = Boolean(seededRaw);
    if (syncId) ingestedSyncIds.add(String(syncId));
    const doc = docByPath.get(docPath);
    const rep = repByDistinctId.get(distId) || REPS[0];
    if (!doc) continue;
    const sv = SURVEY[doc.id];
    if (ans === "Yes") sv.yes += 1;
    else if (ans === "Partly") sv.partly += 1;
    else if (ans === "No") sv.no += 1;
    if (!seeded && SURVEY_ANSWERS.has(ans)) {
      sv.mine[rep.id] = ans;
    }
    const note = (noteRaw && noteRaw !== "null" ? String(noteRaw) : "").trim();
    if (note) {
      MISSING[doc.id] = MISSING[doc.id] || [];
      if (!MISSING[doc.id].some(m => m.rep === rep.id && m.text === note)) {
        if (seeded) {
          MISSING[doc.id].push({ rep: rep.id, text: note });
        } else {
          MISSING[doc.id].unshift({ rep: rep.id, text: note });
        }
      }
    }
  }

  // Merge any recent live events not yet visible in ClickHouse (deduplicated by ph_sync_id).
  // Only the local server keeps such a store; on serverless hosting this is a no-op.
  for (const ev of recent()) {
    const syncId = ev?.properties?.ph_sync_id;
    if (syncId && ingestedSyncIds.has(String(syncId))) continue;
    applyEventToStats(ev, DATA, SURVEY, MISSING);
  }

  return {
    data: DATA,
    survey: SURVEY,
    missing: MISSING,
    source: "posthog-cloud",
    projectId: Number(projectId),
  };
}

const json = (status, obj, extra = {}) => ({
  status,
  headers: { "Content-Type": "application/json", ...CORS, ...extra },
  body: JSON.stringify(obj),
});

// handleApi({ method, pathname, query: URLSearchParams, bodyText, env, store }) -> { status, headers, body } | null
// Returns null for paths that are not part of the API so the caller can serve its own routes.
async function handleApi({ method, pathname, query, bodyText = "", env = {}, store = null }) {
  if (!pathname.startsWith("/api/")) return null;
  try {
    if (method === "OPTIONS") return { status: 204, headers: { ...CORS }, body: "" };
    const cfg = readEnv(env);

    if (method === "GET" && pathname === "/api/config") {
      const surveyId = await resolveSurveyId(cfg);
      return json(200, {
        posthogKey: cfg.projectToken,
        posthogHost: cfg.ingestHost,
        projectId: cfg.projectId ? Number(cfg.projectId) : null,
        surveyId,
      }, { "Cache-Control": "no-store" });
    }

    if (method === "GET" && pathname === "/api/stats") {
      return json(200, await fetchPostHogStats(env, store), { "Cache-Control": "no-store" });
    }

    if (method === "GET" && pathname === "/api/doc") {
      const doc = docById.get(query.get("id") || "") || docByPath.get(query.get("path") || "");
      if (!doc) return json(404, { error: "Unknown handbook page id or path" });
      return json(200, await fetchLiveDocFromGitHub(doc, query.get("refresh") === "1"), { "Cache-Control": "no-store" });
    }

    if (method === "POST" && pathname === "/api/event-sync") {
      if (Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) return json(413, { error: "payload too large" });
      let parsed;
      try { parsed = JSON.parse(bodyText || "{}"); } catch { return json(400, { error: "invalid JSON" }); }
      const v = validateEvent(parsed);
      if (!v.ok) return json(400, { error: v.error });
      if (store) store.save(v.event);
      return json(200, { ok: true, persisted: Boolean(store) });
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("API error:", err);
    return json(500, { error: String(err.message || err) });
  }
}

module.exports = { handleApi, validateEvent, applyEventToStats, emptyStatsStructures, MAX_BODY_BYTES };
