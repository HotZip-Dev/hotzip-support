// Runs the relay against a fake GitHub API and checks every rule.
//   node test.js
"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const ORIGIN = "https://hotzip.dev";
let received = [];
let githubFails = false;

const crypto = require("crypto");
const appKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = appKeys.privateKey.export({ type: "pkcs1", format: "pem" });
let appTokenCalls = 0, appJwtValid = null;

const fakeGitHub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (githubFails) { res.writeHead(500); return res.end("{}"); }
    if (req.url === "/app/installations/777/access_tokens") {
      // Check the relay's signed JWT with the app's public key.
      appTokenCalls++;
      const [h, p, s] = String(req.headers.authorization || "").replace(/^Bearer /, "").split(".");
      const sig = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      const claims = JSON.parse(Buffer.from(p, "base64").toString());
      appJwtValid = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(appKeys.publicKey, sig) && claims.iss === "4242";
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ token: "installation-token", expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    }
    const lab = req.url.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/);
    if (lab) { // like GitHub: labels are added in a second call
      received[Number(lab[1]) - 1].labels = JSON.parse(body).labels;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end("[]");
    }
    const issue = JSON.parse(body);
    received.push({ url: req.url, auth: req.headers.authorization, issue, sentLabels: issue.labels, labels: [] });
    const number = received.length;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ number, html_url: `https://github.com/HotZip-Dev/hotzip-support/issues/${number}` }));
  });
});

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
  if (!ok) failures++;
}

async function call(port, { method = "POST", origin = ORIGIN, ip = "1.1.1.1", body, raw, path: p = "/report" } = {}) {
  const headers = { "Content-Type": "application/json", "X-Forwarded-For": ip };
  if (origin) headers.Origin = origin;
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers, body: method === "POST" ? (raw !== undefined ? raw : JSON.stringify(body)) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, acao: res.headers.get("access-control-allow-origin") };
}

const BUG = { addon: "OnlyOres", type: "bug", version: "v1.0.3", details: "Pins vanish after /reload\nsecond line", errors: "Interface\\AddOns\\OnlyOres\\Engine.lua:12: oops", website: "" };

(async () => {
  await new Promise((r) => fakeGitHub.listen(0, r));
  const ghPort = fakeGitHub.address().port;
  const relayPort = 18000 + Math.floor(Math.random() * 1000);
  const relay = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(relayPort), GITHUB_TOKEN: "test-token", GITHUB_API: `http://127.0.0.1:${ghPort}`, REPO: "HotZip-Dev/hotzip-support" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  relay.stdout.on("data", (d) => (logs += d));
  relay.stderr.on("data", (d) => (logs += d));
  await new Promise((r) => setTimeout(r, 600));

  try {
    let r = await call(relayPort, { method: "GET", path: "/health", origin: null });
    check("health check answers", r.status === 200, r.status);

    r = await call(relayPort, { body: BUG });
    const got = received[0];
    check("bug report creates an issue (201 + url)", r.status === 201 && /issues\/1$/.test(r.data.url), JSON.stringify(r));
    check("CORS header is hotzip.dev", r.acao === ORIGIN, r.acao);
    check("posts to the right repo with the token", got && got.url === "/repos/HotZip-Dev/hotzip-support/issues" && got.auth === "Bearer test-token", JSON.stringify(got && { url: got.url, auth: got.auth }));
    check("title is '[Bug] OnlyOres: first line…'", got && got.issue.title === "[Bug] OnlyOres: Pins vanish after /reload…", got && got.issue.title);
    check("labels are bug + OnlyOres", got && JSON.stringify(got.labels) === '["bug","OnlyOres"]', got && JSON.stringify(got.labels));
    check("labels are added after creating, not in the create call", got && got.sentLabels === undefined, got && JSON.stringify(got.sentLabels));
    check("body has the form's ### Addon layout", got && got.issue.body.startsWith("### Addon\n\nOnlyOres\n"), got && got.issue.body.slice(0, 40));
    check("error text is in a code block", got && got.issue.body.includes("```text\nInterface"), "");

    r = await call(relayPort, { ip: "2.2.2.2", body: { addon: "WowTogether", type: "idea", version: "v9", details: "Let me filter by role please", errors: "should be dropped" } });
    const idea = received[1];
    check("idea creates an issue", r.status === 201, r.status);
    check("idea skips version and error text", idea && !idea.issue.body.includes("v9") && !idea.issue.body.includes("dropped") && idea.issue.body.includes("### Your idea"), idea && idea.issue.body);
    check("idea labels are idea + WowTogether", idea && JSON.stringify(idea.labels) === '["idea","WowTogether"]', idea && JSON.stringify(idea.labels));

    r = await call(relayPort, { ip: "3.3.3.3", body: { addon: "Other", type: "bug", details: "Something else broke" } });
    check("'Other' gets only the bug label", r.status === 201 && JSON.stringify(received[2].labels) === '["bug"]', JSON.stringify(received[2] && received[2].labels));

    r = await call(relayPort, { ip: "4.4.4.4", body: { addon: "OnlyOres", type: "bug", details: "ping @octocat and ``` break out\n```\nhi" } });
    const safe = received[3] && received[3].issue.body;
    check("@mentions can't ping anyone", safe && !/@octocat/.test(safe) && safe.includes("@​octocat"), safe);

    const before = received.length;
    r = await call(relayPort, { ip: "5.5.5.5", body: { ...BUG, website: "http://spam.example" } });
    check("honeypot: quiet OK, no issue", r.status === 200 && received.length === before, `${r.status} ${received.length}`);

    r = await call(relayPort, { ip: "6.6.6.6", body: { ...BUG, addon: "EvilAddon" } });
    check("unknown addon is refused", r.status === 400, r.status);
    r = await call(relayPort, { ip: "6.6.6.6", body: { ...BUG, type: "rant" } });
    check("unknown type is refused", r.status === 400, r.status);
    r = await call(relayPort, { ip: "6.6.6.6", body: { ...BUG, details: "hi" } });
    check("too-short report is refused", r.status === 400, r.status);
    r = await call(relayPort, { ip: "6.6.6.6", raw: "not json" });
    check("broken JSON is refused", r.status === 400, r.status);
    r = await call(relayPort, { ip: "6.6.6.6", raw: JSON.stringify({ ...BUG, details: "x".repeat(30000) }) });
    check("oversized request gets a clear 413", r.status === 413 && /too long/.test(r.data.error), JSON.stringify(r));

    r = await call(relayPort, { origin: "https://evil.example", body: BUG });
    check("other websites are refused (403, no CORS header)", r.status === 403 && !r.acao, `${r.status} ${r.acao}`);
    r = await call(relayPort, { origin: null, body: BUG });
    check("requests without an origin are refused", r.status === 403, r.status);

    let res = await fetch(`http://127.0.0.1:${relayPort}/report`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    check("preflight from hotzip.dev is allowed", res.status === 204 && res.headers.get("access-control-allow-origin") === ORIGIN, res.status);
    res = await fetch(`http://127.0.0.1:${relayPort}/report`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    check("preflight from another site is refused", res.status === 403, res.status);

    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await call(relayPort, { ip: "7.7.7.7", body: BUG })).status);
    check("6th report from one IP within an hour gets 429", statuses.slice(0, 5).every((s) => s === 201) && statuses[5] === 429, statuses.join(","));

    githubFails = true;
    r = await call(relayPort, { ip: "8.8.8.8", body: BUG });
    check("GitHub outage gives a friendly 502", r.status === 502 && /try again/i.test(r.data.error), JSON.stringify(r));
    githubFails = false;

    check("logs never contain report text", !/Pins vanish|octocat|Let me filter/.test(logs), logs);
    check("logs never contain IP addresses", !/\d+\.\d+\.\d+\.\d+/.test(logs.replace(/127\.0\.0\.1/g, "")), logs);
  } finally {
    relay.kill();
  }

  // Second relay, signed in as a GitHub App instead of with a token.
  const appPort = relayPort + 1;
  const appRelay = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(appPort), GITHUB_TOKEN: "", GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "777",
      GITHUB_APP_PRIVATE_KEY: APP_PEM.replace(/\n/g, "\\n"), GITHUB_API: `http://127.0.0.1:${ghPort}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let appLogs = "";
  appRelay.stdout.on("data", (d) => (appLogs += d));
  appRelay.stderr.on("data", (d) => (appLogs += d));
  await new Promise((r) => setTimeout(r, 600));
  try {
    const before = received.length;
    let r = await call(appPort, { ip: "9.9.9.1", body: BUG });
    check("app: report creates an issue", r.status === 201, JSON.stringify(r) + appLogs);
    check("app: signed JWT verifies with the app's public key", appJwtValid === true, appJwtValid);
    check("app: issue is created with the installation token", received[before] && received[before].auth === "Bearer installation-token", received[before] && received[before].auth);
    await call(appPort, { ip: "9.9.9.2", body: BUG });
    check("app: token is reused, not fetched per report", appTokenCalls === 1, appTokenCalls);
    check("app: logs say it runs as a github app", /auth github app/.test(appLogs), appLogs);
  } finally {
    appRelay.kill();
    fakeGitHub.close();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
})();
