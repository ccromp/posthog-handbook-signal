// Regression check: renderSurvey must HTML-escape the stored survey answer (`mine`) before it reaches innerHTML.
// Extracts esc() and renderSurvey() from ph/template.html and runs them with stubs against a malicious answer.
// Includes a negative control (the unescaped variant must be detected) so the check cannot pass vacuously.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "ph", "template.html"), "utf8");
const escLine = src.match(/^const esc = .*$/m);
const fnMatch = src.match(/^function renderSurvey\(\) \{[\s\S]*?^\}/m);
if (!escLine || !fnMatch) { console.error("could not extract esc/renderSurvey"); process.exit(2); }

function render(fnSrc, answer) {
  let html = "";
  const body = `
    ${escLine[0]}
    const surveyDraft = {};
    const state = { doc: "d1", rep: "alex" };
    const SURVEY = { d1: { yes: 0, partly: 0, no: 0, mine: { alex: ANSWER } } };
    const docById = id => ({ id });
    const repById = () => ({ name: "Alex Rivera" });
    const helpful = () => ({ n: 0, p: 0 });
    const pct = () => 0;
    const document = { getElementById: () => ({ set innerHTML(v) { OUT.html = v; }, querySelectorAll: () => [] }) };
    ${fnSrc}
    renderSurvey();`;
  const out = { html: "" };
  new Function("ANSWER", "OUT", body)(answer, out);
  return out.html;
}

const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const safe = render(fnMatch[0], payload);
const unsafe = render(fnMatch[0].replace("esc(mine)", "mine"), payload);

const rawTag = /<(img|script)\b/i;
let failed = false;
if (rawTag.test(safe)) { console.error("FAIL: raw tag survived in renderSurvey output:", safe); failed = true; }
if (!safe.includes("&lt;img")) { console.error("FAIL: escaped payload not present"); failed = true; }
if (!rawTag.test(unsafe)) { console.error("FAIL: negative control did not detect the unescaped variant"); failed = true; }
if (failed) process.exit(1);
console.log("PASS: renderSurvey escapes a malicious survey answer; negative control detects the unescaped variant");
