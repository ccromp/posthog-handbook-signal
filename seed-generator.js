const crypto = require("crypto");

function deterministicUuid(key) {
  const hex = crypto.createHash("md5").update(String(key)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Static require (not readFileSync) so serverless bundlers include the JSON.
const { docs: DOCS, cats: CATS } = require("./data/docs-meta.json");

const REPS = [
  { id: "alex", name: "Alex Rivera", role: "Account Executive · US East", gh: "arivera-sales", c: "var(--c1)", email: "alex.rivera@example.com" },
  { id: "jordan", name: "Jordan Patel", role: "Account Executive · EMEA", gh: "jpatel-sales", c: "var(--c2)", email: "jordan.patel@example.com" },
  { id: "sam", name: "Sam Chen", role: "Solutions Engineer · US West", gh: "samchen-se", c: "var(--c3)", email: "sam.chen@example.com" },
  { id: "taylor", name: "Taylor Brooks", role: "Account Executive · US Central", gh: "tbrooks-ae", c: "var(--c4)", email: "taylor.brooks@example.com" },
  { id: "morgan", name: "Morgan Lee", role: "Customer Success · APAC", gh: "mlee-cs", c: "var(--c5)", email: "morgan.lee@example.com" },
];

const dp = d => d.path.replace("contents/handbook/", "");
const distinctId = r => "rep_" + r.name.toLowerCase().replace(/ /g, "_");
const repProps = r => ({
  name: r.name,
  email: r.email,
  role: r.role.split(" · ")[0],
  region: r.role.split(" · ")[1],
  team: "Sales",
  github: r.gh,
});

const PROFILE = {
  "error-tracking": [11, .80, 1], "logs": [8, .72, .95], "workflows": [7, .66, .9],
  "session-replay": [10, .30, 1], "feature-flags": [7, .60, .9], "analytics": [8, .54, .95],
  "experiments": [5, .48, .8], "llm-analytics": [6, .56, .8], "posthog-ai": [6, .45, .85],
  "data-warehouse": [4, .38, .6], "data-pipelines": [3, .34, .55], "replay-vision": [4, .27, .6],
  "desktop": [5, .42, .7], "endpoints": [2, .2, .4],
};

const CAT_PROFILE = {
  "Overview": [3, .5, .4], "New business": [6, .62, .8], "Product-led sales": [5, .55, .75],
  "Customer Success": [3, .5, .22], "Forward deployed engineering": [2, .45, .12], "Shareable guides": [2, .6, .15],
  "Onboarding": [3, .48, .18], "Use-case selling": [6, .64, .8], "Cross-selling": [5, .58, .7],
  "Account management": [4, .52, .4], "Contracts & billing": [6, .72, .8], "Tools & systems": [3, .38, .28],
  "Enablement & resources": [3, .5, .32], "Working with customers in person": [1, .5, .12],
};

const AFFINITY = {
  sam: { "Use-case selling": 1.6, "Tools & systems": 1.5, "Forward deployed engineering": 2, "Contracts & billing": .6 },
  morgan: { "Customer Success": 2, "Account management": 1.8, "Onboarding": 1.8, "New business": .4, "Product positioning": .7 },
  jordan: { "New business": 1.4, "Contracts & billing": 1.3 },
  taylor: { "Product-led sales": 1.5, "Cross-selling": 1.4 },
};

const SEED_MISSING = {
  "session-replay": [
    { rep: "taylor", text: "Had a FullStory renewal call. I needed the pricing comparison first and it took me too long to find it." },
    { rep: "jordan", text: "The pitch is good. I wanted one line for privacy-sensitive buyers in Germany." },
  ],
  "replay-vision": [{ rep: "sam", text: "I couldn't tell how this differs from Session Replay in one sentence." }],
  "endpoints": [{ rep: "alex", text: "Not sure when to bring this up in a deal. A 'when to pitch it' line would help." }],
  "data-pipelines": [{ rep: "morgan", text: "Wanted a named customer for the CDP replacement story." }],
  "desktop": [{ rep: "sam", text: "Opened it before a demo. I needed a two-line version I could say out loud." }],
  "data-warehouse": [{ rep: "taylor", text: "Is 'Context warehouse' the name we say to customers now? Unclear." }],
  "experiments": [{ rep: "jordan", text: "The stats-engine objection is the one I get most. More depth there, please." }],
  "growth/sales/contract-rules": [{ rep: "jordan", text: "Long page. I only needed the discount rules for a two-year deal." }],
  "growth/sales/crm": [{ rep: "taylor", text: "Couldn't find how to log a deal that spans two products." }],
  "growth/sales/utilization-by-business-type": [{ rep: "alex", text: "Great content but too long to use mid-call. A one-table summary per business type would help." }],
  "growth/sales/sales-and-cs-tools": [{ rep: "sam", text: "Some of these tools have moved. Not sure which list is current." }],
};

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateBaselineData() {
  const R = rng(20261024);
  const DATA = {};
  DOCS.forEach(d => {
    let [b, rate, p] = PROFILE[d.id] || CAT_PROFILE[d.cat] || [3, .45, .5];
    if (!PROFILE[d.id]) {
      const k = .45 + R() * 1.1;
      b *= k;
      p = Math.min(1, p * k);
      rate = Math.min(.9, rate * (.75 + R() * .5));
    }
    DATA[d.id] = {};
    REPS.forEach(rep => {
      const aff = (AFFINITY[rep.id] || {})[d.cat] || 1;
      const opened = R() < p * aff;
      if (!opened) {
        DATA[d.id][rep.id] = { views: 0, engaged: 0, dwell: 0, last: null };
        return;
      }
      const views = Math.max(1, Math.round(b * Math.min(aff, 1.4) * (.35 + R() * .8)));
      const r = Math.min(.95, Math.max(0, rate + (R() - .5) * .3));
      const engaged = Math.min(views, Math.round(views * r));
      const dwell = engaged * Math.round(110 + R() * 250) + (views - engaged) * Math.round(5 + R() * 15);
      DATA[d.id][rep.id] = { views, engaged, dwell, last: 1 + Math.floor(R() * 20) };
    });
  });

  const SURVEY = {};
  DOCS.forEach(d => {
    const xs = Object.values(DATA[d.id]);
    const v = xs.reduce((a, x) => a + x.views, 0);
    const rate = v ? xs.reduce((a, x) => a + x.engaged, 0) / v : .5;
    const n = v ? 3 + Math.round(R() * Math.min(13, v)) : 0;
    const yes = Math.round(n * Math.min(.9, rate + .1));
    const no = Math.round((n - yes) * (.3 + (1 - rate) * .4));
    SURVEY[d.id] = { yes, partly: n - yes - no, no, mine: {} };
  });

  const MISSING = JSON.parse(JSON.stringify(SEED_MISSING));
  return { DATA, SURVEY, MISSING };
}

function generatePostHogSeedEvents({ surveyId = "enablement-helpful", nowMs = Date.now() } = {}) {
  const { DATA, SURVEY, MISSING } = generateBaselineData();
  const events = [];
  const DAY_MS = 86400 * 1000;

  // 1. Person profiles ($identify) for the 5 fictional sales reps
  REPS.forEach((rep, idx) => {
    events.push({
      event: "$identify",
      distinct_id: distinctId(rep),
      timestamp: new Date(nowMs - 29 * DAY_MS + idx * 1000).toISOString(),
      properties: {
        $set: repProps(rep),
        rep_id: rep.id,
        seeded: true,
      },
    });
  });

  // 2. Pageviews, engaged reads, and page_left events matching DATA[d.id][rep.id]
  DOCS.forEach((d, dIdx) => {
    const docPath = dp(d);
    REPS.forEach((rep, rIdx) => {
      const x = DATA[d.id][rep.id];
      if (!x || !x.views) return;
      const distId = distinctId(rep);
      const bounces = x.views - x.engaged;
      // Split total dwell across engaged views and bounce views so the sum matches x.dwell exactly
      const bounceDwellTotal = bounces > 0 ? Math.min(x.dwell - x.engaged * 30, bounces * 12) : 0;
      const engagedDwellTotal = x.dwell - Math.max(0, bounceDwellTotal);

      for (let i = 0; i < x.views; i++) {
        const isEngaged = i < x.engaged;
        let viewDwell;
        if (isEngaged) {
          const base = Math.floor(engagedDwellTotal / x.engaged);
          const rem = engagedDwellTotal - base * x.engaged;
          viewDwell = base + (i === 0 ? rem : 0);
        } else {
          const bIdx = i - x.engaged;
          const base = bounces > 0 ? Math.floor(Math.max(0, bounceDwellTotal) / bounces) : 10;
          const rem = Math.max(0, bounceDwellTotal) - base * bounces;
          viewDwell = base + (bIdx === 0 ? rem : 0);
        }

        // Most recent view (i === 0) lands `x.last` days ago; older views spread across days (x.last .. 28)
        const daysAgo = i === 0 ? x.last : Math.min(28, x.last + i);
        const tsBase = nowMs - daysAgo * DAY_MS - ((dIdx * 7 + rIdx * 3 + i) % 3600) * 1000;
        const tsView = new Date(tsBase).toISOString();
        const tsEngaged = new Date(tsBase + 30 * 1000).toISOString();
        const tsLeft = new Date(tsBase + Math.max(1, viewDwell) * 1000).toISOString();

        events.push({
          event: "$pageview",
          distinct_id: distId,
          timestamp: tsView,
          properties: {
            $current_url: `https://posthog.com${d.url}`,
            doc_id: d.id,
            doc_path: docPath,
            category: d.cat,
            rep_id: rep.id,
            seeded: true,
          },
        });

        if (isEngaged) {
          events.push({
            event: "enablement_engaged_read",
            distinct_id: distId,
            timestamp: tsEngaged,
            properties: {
              doc_id: d.id,
              doc_path: docPath,
              category: d.cat,
              threshold_seconds: 30,
              rep_id: rep.id,
              seeded: true,
            },
          });
        }

        events.push({
          event: "enablement_page_left",
          distinct_id: distId,
          timestamp: tsLeft,
          properties: {
            doc_id: d.id,
            doc_path: docPath,
            category: d.cat,
            dwell_seconds: viewDwell,
            engaged_read: isEngaged,
            rep_id: rep.id,
            seeded: true,
          },
        });
      }
    });

    // 3. Survey responses + MISSING quotes for doc d
    const sv = SURVEY[d.id];
    const quotes = (MISSING[d.id] || []).slice();
    const responses = [];
    for (let i = 0; i < sv.yes; i++) responses.push({ ans: "Yes", note: "" });
    for (let i = 0; i < sv.partly; i++) responses.push({ ans: "Partly", note: "" });
    for (let i = 0; i < sv.no; i++) responses.push({ ans: "No", note: "" });

    // Attach quotes to non-Yes responses first (or last responses if needed)
    let qIdx = 0;
    for (let i = responses.length - 1; i >= 0 && qIdx < quotes.length; i--) {
      if (responses[i].ans !== "Yes" || i === 0) {
        responses[i].note = quotes[qIdx].text;
        responses[i].rep = quotes[qIdx].rep;
        qIdx++;
      }
    }
    while (qIdx < quotes.length) {
      responses.push({ ans: "Partly", note: quotes[qIdx].text, rep: quotes[qIdx].rep });
      qIdx++;
    }

    responses.forEach((item, sIdx) => {
      const repObj = item.rep ? REPS.find(r => r.id === item.rep) : REPS[(dIdx + sIdx) % REPS.length];
      const tsSurvey = new Date(nowMs - ((sIdx % 25) + 1) * DAY_MS - (dIdx * 19 + sIdx * 11) * 1000).toISOString();
      const props = {
        $survey_id: surveyId,
        $survey_name: "enablement-helpful",
        $survey_response: item.ans,
        doc_id: d.id,
        doc_path: docPath,
        category: d.cat,
        rep_id: repObj.id,
        seeded: true,
      };
      if (item.note) props.$survey_response_1 = item.note;
      events.push({
        event: "survey sent",
        distinct_id: distinctId(repObj),
        timestamp: tsSurvey,
        properties: props,
      });
    });
  });

  events.forEach((ev, idx) => {
    ev.uuid = deterministicUuid(`ph-seed-v1-${idx}-${ev.event}-${ev.distinct_id}`);
  });

  return events;
}

module.exports = {
  DOCS,
  CATS,
  REPS,
  dp,
  distinctId,
  repProps,
  generateBaselineData,
  generatePostHogSeedEvents,
};
