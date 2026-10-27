const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function loadEnvFile(envPath) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  return out;
}

async function main() {
  const envPath = path.join(__dirname, ".env");
  const savedEnv = loadEnvFile(envPath);

  const stepArg = process.argv.find(a => a.startsWith("--step="))?.split("=")[1] || "signup";
  const codeArg = process.argv.find(a => a.startsWith("--code="))?.split("=")[1] || process.env.POSTHOG_VERIFY_CODE;
  const emailArg =
    process.argv.find(a => a.startsWith("--email="))?.split("=")[1] ||
    process.env.POSTHOG_SIGNUP_EMAIL ||
    savedEnv.POSTHOG_ACCOUNT_EMAIL;
  const passwordArg =
    process.argv.find(a => a.startsWith("--password="))?.split("=")[1] ||
    process.env.POSTHOG_SIGNUP_PASSWORD ||
    savedEnv.POSTHOG_ACCOUNT_PASSWORD;
  const uuidArg =
    process.argv.find(a => a.startsWith("--uuid="))?.split("=")[1] ||
    process.env.POSTHOG_USER_UUID ||
    savedEnv.POSTHOG_USER_UUID;

  const apiHost = (process.env.POSTHOG_API_HOST || savedEnv.POSTHOG_API_HOST || "https://us.posthog.com").replace(/\/$/, "");
  const ingestHost = (process.env.POSTHOG_INGEST_HOST || savedEnv.POSTHOG_INGEST_HOST || "https://us.i.posthog.com").replace(/\/$/, "");

  const cookieJarPath = path.join(__dirname, ".posthog.cookies.txt");
  const cookies = new Map();
  if (fs.existsSync(cookieJarPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(cookieJarPath, "utf8"));
      for (const [k, v] of Object.entries(saved)) cookies.set(k, v);
    } catch (_) {}
  }

  function saveCookieJar() {
    fs.writeFileSync(cookieJarPath, JSON.stringify(Object.fromEntries(cookies.entries()), null, 2), { mode: 0o600 });
  }

  function updateCookies(res) {
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookie) {
      const [pair] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) {
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    saveCookieJar();
  }

  function cookieHeader() {
    return Array.from(cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  if (!cookies.has("posthog_csrftoken")) {
    const loginPage = await fetch(`${apiHost}/login`);
    updateCookies(loginPage);
  }

  let userUuid = uuidArg;
  const password = passwordArg || `PhSignal!${crypto.randomBytes(8).toString("hex")}9A`;

  if (stepArg === "signup") {
    if (!emailArg) {
      throw new Error("Pass --email=<email> or set POSTHOG_SIGNUP_EMAIL");
    }

    const signupHeaders = {
      "Content-Type": "application/json",
      Origin: apiHost,
      Referer: `${apiHost}/signup`,
    };
    if (cookies.size) signupHeaders.Cookie = cookieHeader();
    if (cookies.has("posthog_csrftoken")) signupHeaders["X-CSRFToken"] = cookies.get("posthog_csrftoken");

    const signupRes = await fetch(`${apiHost}/api/signup/`, {
      method: "POST",
      headers: signupHeaders,
      body: JSON.stringify({
        first_name: "Chris",
        email: emailArg,
        password,
        organization_name: "Handbook Signal",
        role_at_organization: "marketing",
      }),
    });
    updateCookies(signupRes);

    const signupBody = await signupRes.json().catch(() => ({}));
    if (!signupRes.ok) {
      throw new Error(`POST /api/signup/ failed (HTTP ${signupRes.status}): ${JSON.stringify(signupBody)}`);
    }

    userUuid = signupBody.uuid;
    const pendingEnv = [
      `POSTHOG_API_HOST=${apiHost}`,
      `POSTHOG_INGEST_HOST=${ingestHost}`,
      `POSTHOG_ACCOUNT_EMAIL=${emailArg}`,
      `POSTHOG_ACCOUNT_PASSWORD=${password}`,
      `POSTHOG_USER_UUID=${userUuid || ""}`,
      "",
    ].join("\n");
    fs.writeFileSync(envPath, pendingEnv, { mode: 0o600 });

    if (signupBody.is_email_verified === false && !codeArg) {
      console.log(
        JSON.stringify(
          {
            status: "verification_code_sent",
            email: emailArg,
            uuid: userUuid,
            redirectUrl: signupBody.redirect_url,
          },
          null,
          2
        )
      );
      return;
    }
  } else if (stepArg === "login") {
    const loginHeaders = {
      "Content-Type": "application/json",
      Origin: apiHost,
      Referer: `${apiHost}/login`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    if (cookies.size) loginHeaders.Cookie = cookieHeader();
    if (cookies.has("posthog_csrftoken")) loginHeaders["X-CSRFToken"] = cookies.get("posthog_csrftoken");

    const loginRes = await fetch(`${apiHost}/api/login/`, {
      method: "POST",
      headers: loginHeaders,
      body: JSON.stringify({
        email: emailArg,
        password,
      }),
    });
    updateCookies(loginRes);
    const loginBody = await loginRes.json().catch(() => ({}));
    if (loginRes.status === 401 && loginBody.code === "code_based_verification_required") {
      console.log(JSON.stringify({ status: "login_code_sent", email: emailArg }, null, 2));
      return;
    }
    if (!loginRes.ok) {
      throw new Error(`POST /api/login/ failed (HTTP ${loginRes.status}): ${JSON.stringify(loginBody)}`);
    }
  } else if (stepArg === "login-code") {
    if (!codeArg) throw new Error("Pass --code=<6-digit code>");
    const codeHeaders = {
      "Content-Type": "application/json",
      Origin: apiHost,
      Referer: `${apiHost}/login/verify`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    if (cookies.size) codeHeaders.Cookie = cookieHeader();
    if (cookies.has("posthog_csrftoken")) codeHeaders["X-CSRFToken"] = cookies.get("posthog_csrftoken");

    const codeRes = await fetch(`${apiHost}/api/login/code-based-verification/`, {
      method: "POST",
      headers: codeHeaders,
      body: JSON.stringify({
        code: String(codeArg).trim(),
        email: emailArg,
      }),
    });
    updateCookies(codeRes);
    const codeBody = await codeRes.json().catch(() => ({}));
    if (!codeRes.ok) {
      throw new Error(`POST /api/login/code-based-verification/ failed (HTTP ${codeRes.status}): ${JSON.stringify(codeBody)}`);
    }
  } else if (stepArg === "verify") {
    if (!codeArg) throw new Error("Pass --code=<6-digit code>");
    if (!userUuid) {
      throw new Error("Missing POSTHOG_USER_UUID for email verification");
    }
    const verifyHeaders = {
      "Content-Type": "application/json",
      Origin: apiHost,
      Referer: `${apiHost}/verify_email/${userUuid}`,
    };
    if (cookies.size) verifyHeaders.Cookie = cookieHeader();
    if (cookies.has("posthog_csrftoken")) verifyHeaders["X-CSRFToken"] = cookies.get("posthog_csrftoken");

    const verifyRes = await fetch(`${apiHost}/api/users/verify_email/`, {
      method: "POST",
      headers: verifyHeaders,
      body: JSON.stringify({
        uuid: userUuid,
        code: String(codeArg).trim(),
      }),
    });
    updateCookies(verifyRes);

    const verifyBody = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) {
      throw new Error(`POST /api/users/verify_email/ failed (HTTP ${verifyRes.status}): ${JSON.stringify(verifyBody)}`);
    }
  }

  // Fetch /api/users/@me/ to read team/project id and api_token (phc_...)
  const authHeaders = {
    "Content-Type": "application/json",
    Origin: apiHost,
    Referer: `${apiHost}/`,
    Cookie: cookieHeader(),
  };
  if (cookies.has("posthog_csrftoken")) authHeaders["X-CSRFToken"] = cookies.get("posthog_csrftoken");

  const meRes = await fetch(`${apiHost}/api/users/@me/`, { headers: authHeaders });
  updateCookies(meRes);
  if (!meRes.ok) {
    throw new Error(`GET /api/users/@me/ failed (HTTP ${meRes.status}): ${await meRes.text()}`);
  }
  const me = await meRes.json();
  const team = me.team || me.organization?.teams?.[0];
  if (!team || !team.id || !team.api_token) {
    throw new Error(`Could not find team/project in /api/users/@me/ response: ${JSON.stringify(me).slice(0, 400)}`);
  }

  // Rename project to "Handbook Signal" for clarity
  if (cookies.has("posthog_csrftoken")) authHeaders["X-CSRFToken"] = cookies.get("posthog_csrftoken");
  authHeaders.Cookie = cookieHeader();
  await fetch(`${apiHost}/api/projects/${team.id}/`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ name: "Handbook Signal" }),
  }).catch(() => {});

  // Create Personal API Key (phx_...)
  const keyRes = await fetch(`${apiHost}/api/personal_api_keys/`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      label: "Handbook Signal Server",
      scopes: ["*"],
      scoped_teams: [team.id],
      scoped_organizations: [],
    }),
  });
  if (!keyRes.ok) {
    throw new Error(`POST /api/personal_api_keys/ failed (HTTP ${keyRes.status}): ${await keyRes.text()}`);
  }
  const keyData = await keyRes.json();
  const personalKey = keyData.value;
  if (!personalKey) {
    throw new Error(`No key value returned from /api/personal_api_keys/`);
  }

  // Write .env (gitignored)
  const envContent = [
    `POSTHOG_API_HOST=${apiHost}`,
    `POSTHOG_INGEST_HOST=${ingestHost}`,
    `POSTHOG_ACCOUNT_EMAIL=${emailArg}`,
    `POSTHOG_ACCOUNT_PASSWORD=${password}`,
    `POSTHOG_USER_UUID=${userUuid || me.uuid || ""}`,
    `POSTHOG_PROJECT_ID=${team.id}`,
    `POSTHOG_PROJECT_TOKEN=${team.api_token}`,
    `POSTHOG_PERSONAL_API_KEY=${personalKey}`,
    "",
  ].join("\n");
  fs.writeFileSync(envPath, envContent, { mode: 0o600 });

  console.log(
    JSON.stringify(
      {
        url: `${apiHost}/project/${team.id}`,
        email: emailArg,
        password,
        projectId: team.id,
        projectToken: team.api_token,
        personalApiKeyCreated: true,
      },
      null,
      2
    )
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
