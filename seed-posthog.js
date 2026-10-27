const fs = require("fs");
const path = require("path");
const { REPS, distinctId, generatePostHogSeedEvents } = require("./seed-generator.js");

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].replace(/^['"]|['"]$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

async function hogql(apiHost, projectId, personalKey, query) {
  const res = await fetch(`${apiHost}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${personalKey}`,
      "Content-Type": "application/json",
    },
    // force_blocking: bypass PostHog's query cache, which would otherwise return the pre-ingestion (empty) result
    body: JSON.stringify({ query: { kind: "HogQLQuery", query }, refresh: "force_blocking" }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HogQL HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }
  return res.json();
}

function getExpectedSeedComposition(events) {
  const expectedByEvent = {};
  for (const ev of events) {
    expectedByEvent[ev.event] = (expectedByEvent[ev.event] || 0) + 1;
  }
  const expectedReps = REPS.map(r => distinctId(r)).sort();
  return { expectedByEvent, expectedReps };
}

async function verifySeededDataset(apiHost, projectId, personalKey, expectedByEvent, expectedReps, surveyId) {
  const [suffixRes, eventRes, repRes, surveyIdRes] = await Promise.all([
    hogql(
      apiHost,
      projectId,
      personalKey,
      `SELECT substring(toString(timestamp), 20, 4) AS seed_suffix, count()
       FROM events
       WHERE toString(properties.seeded) = 'true'
         AND timestamp >= now() - INTERVAL 30 DAY
       GROUP BY seed_suffix
       ORDER BY seed_suffix`
    ),
    hogql(
      apiHost,
      projectId,
      personalKey,
      `SELECT event, count()
       FROM events
       WHERE toString(properties.seeded) = 'true'
         AND timestamp >= now() - INTERVAL 30 DAY
       GROUP BY event`
    ),
    hogql(
      apiHost,
      projectId,
      personalKey,
      `SELECT
         groupUniqArrayIf(distinct_id, event = '$identify') AS identify_reps,
         groupUniqArrayIf(distinct_id, event IN ('$pageview', 'enablement_engaged_read', 'enablement_page_left', 'survey sent')) AS telemetry_reps
       FROM events
       WHERE toString(properties.seeded) = 'true'
         AND timestamp >= now() - INTERVAL 30 DAY`
    ),
    hogql(
      apiHost,
      projectId,
      personalKey,
      `SELECT toString(properties.$survey_id) AS survey_id, count()
       FROM events
       WHERE toString(properties.seeded) = 'true'
         AND event = 'survey sent'
         AND timestamp >= now() - INTERVAL 30 DAY
       GROUP BY survey_id`
    ),
  ]);

  const suffixRows = suffixRes?.results || [];
  const seedSuffixes = suffixRows
    .map(r => (Array.isArray(r) ? r[0] : r))
    .filter(s => s !== null && s !== undefined && String(s).trim() !== "")
    .map(String);
  const singleSeedSuffix =
    suffixRows.length === 1 &&
    seedSuffixes.length === 1 &&
    /^\.\d{3}$/.test(seedSuffixes[0]) &&
    Number(suffixRows[0]?.[1] || 0) === 4120;

  const countsByEvent = {};
  for (const [evName, ct] of eventRes?.results || []) {
    countsByEvent[String(evName)] = Number(ct || 0);
  }

  const identifyReps = Array.isArray(repRes?.results?.[0]?.[0])
    ? repRes.results[0][0].map(String).sort()
    : [];
  const telemetryReps = Array.isArray(repRes?.results?.[0]?.[1])
    ? repRes.results[0][1].map(String).sort()
    : [];

  // PostHog links `survey sent` to a survey by UUID: every seeded survey event must carry exactly this one,
  // so a dataset stamped with the survey name (or another survey) is rejected as contaminated.
  const surveyIdCounts = {};
  for (const [sid, ct] of surveyIdRes?.results || []) {
    surveyIdCounts[String(sid)] = Number(ct || 0);
  }
  const surveyIdKeys = Object.keys(surveyIdCounts);
  const surveyIdMatch =
    surveyIdKeys.length === 1 &&
    surveyIdKeys[0] === String(surveyId) &&
    surveyIdCounts[surveyIdKeys[0]] === Number(expectedByEvent["survey sent"] || 0);

  const expectedKeys = Object.keys(expectedByEvent).sort();
  const actualKeys = Object.keys(countsByEvent).sort();
  const eventNamesMatch =
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((k, i) => k === expectedKeys[i]);

  const eventsMatch =
    eventNamesMatch &&
    expectedKeys.every(evName => countsByEvent[evName] === expectedByEvent[evName]);

  const expectedTotal = expectedKeys.reduce((acc, k) => acc + Number(expectedByEvent[k] || 0), 0);
  const actualTotal = actualKeys.reduce((acc, k) => acc + Number(countsByEvent[k] || 0), 0);
  const totalMatch = expectedTotal === 4120 && actualTotal === 4120 && actualTotal === expectedTotal;

  const sortedExpectedReps = [...expectedReps].map(String).sort();
  const identifyMatch =
    sortedExpectedReps.length === 5 &&
    identifyReps.length === sortedExpectedReps.length &&
    identifyReps.every((r, i) => r === sortedExpectedReps[i]);
  const telemetryMatch =
    sortedExpectedReps.length === 5 &&
    telemetryReps.length === sortedExpectedReps.length &&
    telemetryReps.every((r, i) => r === sortedExpectedReps[i]);

  return {
    complete: Boolean(singleSeedSuffix && eventsMatch && totalMatch && identifyMatch && telemetryMatch && surveyIdMatch),
    total: actualTotal,
    expectedTotal,
    seedSuffixes,
    countsByEvent,
    surveyIdCounts,
    identifyReps,
    telemetryReps,
  };
}

async function ensureSurvey(apiHost, projectId, personalKey) {
  const listRes = await fetch(`${apiHost}/api/projects/${projectId}/surveys/`, {
    headers: { Authorization: `Bearer ${personalKey}` },
  });
  if (!listRes.ok) {
    throw new Error(`Failed to list surveys: HTTP ${listRes.status} ${await listRes.text()}`);
  }
  const listJson = await listRes.json();
  const surveys = listJson.results || listJson || [];
  const existing = surveys.find(s => s.name === "enablement-helpful");
  if (existing) {
    console.log(`Found existing survey 'enablement-helpful': ${existing.id}`);
    return existing;
  }

  const createRes = await fetch(`${apiHost}/api/projects/${projectId}/surveys/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${personalKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "enablement-helpful",
      description: "In-page sales enablement usefulness pulse across the 121 PostHog handbook pages.",
      type: "api",
      questions: [
        {
          type: "single_choice",
          question: "Did this page help you on a live deal?",
          choices: ["Yes", "Partly", "No"],
        },
        {
          type: "open",
          question: "What was missing for your deal?",
          optional: true,
        },
      ],
      start_date: new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Failed to create survey: HTTP ${createRes.status} ${await createRes.text()}`);
  }
  const created = await createRes.json();
  console.log(`Created survey 'enablement-helpful': ${created.id}`);
  return created;
}

async function main() {
  loadEnv();
  const apiHost = (process.env.POSTHOG_API_HOST || "https://us.posthog.com").replace(/\/$/, "");
  const ingestHost = (process.env.POSTHOG_INGEST_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
  const personalKey = process.env.POSTHOG_PERSONAL_API_KEY;

  if (!projectId || !projectToken || !personalKey) {
    throw new Error("Missing POSTHOG_PROJECT_ID, POSTHOG_PROJECT_TOKEN, or POSTHOG_PERSONAL_API_KEY in .env");
  }

  const survey = await ensureSurvey(apiHost, projectId, personalKey);

  const events = generatePostHogSeedEvents({ surveyId: survey.id });
  const { expectedByEvent, expectedReps } = getExpectedSeedComposition(events);

  // Verify exact expected composition before skipping
  const precheck = await verifySeededDataset(apiHost, projectId, personalKey, expectedByEvent, expectedReps, survey.id);
  if (precheck.complete && !process.argv.includes("--force")) {
    console.log(
      `PostHog project ${projectId} already has full verified seed composition:`,
      precheck.countsByEvent,
      "suffixes:",
      precheck.seedSuffixes,
      "reps:",
      precheck.identifyReps
    );
    return;
  }
  if ((precheck.total > 0 || precheck.seedSuffixes.length > 0) && !process.argv.includes("--force")) {
    throw new Error(
      `PostHog project ${projectId} contains contaminated or incomplete seeded events (total=${precheck.total}, suffixes=${JSON.stringify(precheck.seedSuffixes)}, counts=${JSON.stringify(precheck.countsByEvent)}, survey_ids=${JSON.stringify(precheck.surveyIdCounts)}). Clean the project before re-seeding.`
    );
  }

  console.log(`Generated ${events.length} historical events across 5 reps and 121 pages. Sending batches to ${ingestHost}/batch/ ...`);

  const chunkSize = 500;
  for (let i = 0; i < events.length; i += chunkSize) {
    const batch = events.slice(i, i + chunkSize);
    const res = await fetch(`${ingestHost}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: projectToken,
        historical_migration: false,
        batch,
      }),
    });
    if (!res.ok) {
      throw new Error(`Batch ${i / chunkSize + 1} failed: HTTP ${res.status} ${await res.text()}`);
    }
    console.log(`  Sent batch ${Math.floor(i / chunkSize) + 1}/${Math.ceil(events.length / chunkSize)} (${batch.length} events)`);
  }

  console.log("Waiting for ClickHouse ingestion verification of exact event & rep composition...");
  let verified = false;
  let lastStatus = null;
  for (let attempt = 1; attempt <= 90; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    lastStatus = await verifySeededDataset(apiHost, projectId, personalKey, expectedByEvent, expectedReps, survey.id);
    console.log(
      `  Attempt ${attempt}: total=${lastStatus.total} suffixes=${JSON.stringify(lastStatus.seedSuffixes)} counts=${JSON.stringify(lastStatus.countsByEvent)} identifyReps=${lastStatus.identifyReps.length}/5 telemetryReps=${lastStatus.telemetryReps.length}/5`
    );
    if (lastStatus.complete) {
      verified = true;
      console.log("All 30-day historical telemetry and 5 rep person profiles verified in PostHog ClickHouse!");
      break;
    }
  }

  if (!verified) {
    throw new Error(
      `Seeded dataset verification failed after 90 attempts. Expected ${JSON.stringify(expectedByEvent)} across ${JSON.stringify(expectedReps)}, got ${JSON.stringify(lastStatus)}`
    );
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { ensureSurvey, hogql, getExpectedSeedComposition, verifySeededDataset };
