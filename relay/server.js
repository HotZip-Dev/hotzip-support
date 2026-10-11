// Support relay: turns the hotzip.dev support form into a GitHub issue, so
// players can report bugs and ideas without a GitHub account.
//
//   POST /report  { addon, type, version, details, errors, website }
//   GET  /health
//
// Settings (environment variables). Use a GitHub App (issues then show as made
// by the app's bot, never a person):
//   GITHUB_APP_ID               the app's ID
//   GITHUB_APP_INSTALLATION_ID  the ID of its installation on the HotZip-Dev org
//   GITHUB_APP_PRIVATE_KEY      the app's private key (PEM; "\n" escapes are fine)
// or, as a fallback, a token (issues then show as the token's owner):
//   GITHUB_TOKEN     fine-grained token: Issues read/write on REPO only
// and:
//   REPO             owner/name of the issue repo (default HotZip-Dev/hotzip-support)
//   ALLOWED_ORIGINS  comma-separated origins allowed to post (default https://hotzip.dev)
//   PORT             set by Railway
//   GITHUB_API       API base URL (default https://api.github.com; tests point it elsewhere)
//
// Privacy: IP addresses are kept in memory only, for rate limiting, and never
// logged. Report text is never logged.

"use strict";

const http = require("http");
const crypto = require("crypto");

const TOKEN = process.env.GITHUB_TOKEN || "";
const APP_ID = process.env.GITHUB_APP_ID || "";
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || "";
const APP_KEY = (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const USE_APP = Boolean(APP_ID && INSTALLATION_ID && APP_KEY);
const REPO = process.env.REPO || "HotZip-Dev/hotzip-support";
const API = (process.env.GITHUB_API || "https://api.github.com").replace(/\/$/, "");
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://hotzip.dev").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT) || 8080;

// Addons people can report on. Each has a matching label in the repo.
const ADDONS = new Set(["OnlyOres", "OnlyHerbs", "OnlyEnchants", "OnlyNotes", "OnlySplits", "WowTogether", "Other"]);
const TYPES = { bug: "Bug", idea: "Idea" };

const LIMITS = { body: 20000, version: 40, details: 5000, errors: 8000 };
const PER_IP = { max: 5, windowMs: 60 * 60 * 1000 };   // 5 reports per IP per hour
const GLOBAL = { max: 60, windowMs: 60 * 60 * 1000 };  // 60 reports per hour in total

// ------------------------------------------------------------------ rate limits

const hits = new Map(); // ip -> [timestamps]
let globalHits = [];

function allowed(ip, now) {
  globalHits = globalHits.filter((t) => now - t < GLOBAL.windowMs);
  const mine = (hits.get(ip) || []).filter((t) => now - t < PER_IP.windowMs);
  if (mine.length >= PER_IP.max || globalHits.length >= GLOBAL.max) {
    hits.set(ip, mine);
    return false;
  }
  mine.push(now);
  hits.set(ip, mine);
  globalHits.push(now);
  return true;
}

// Forget old entries so the map can't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const fresh = list.filter((t) => now - t < PER_IP.windowMs);
    if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  // Railway sits behind a proxy: the first X-Forwarded-For entry is the visitor.
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

// ------------------------------------------------------------------ text safety

// Player text goes into a public issue. Keep it plain: no control characters,
// no @mentions that would ping people, no closing the code fence early.
function clean(value, max) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/@(?=[A-Za-z0-9-])/g, "@​")
    .trim()
    .slice(0, max);
}

function fenced(text) {
  return "```text\n" + text.replace(/```/g, "'''") + "\n```";
}

function buildIssue(r) {
  const label = TYPES[r.type];
  const firstLine = r.details.split("\n")[0].replace(/\s+/g, " ").slice(0, 70);
  const title = `[${label}] ${r.addon}: ${firstLine}${r.details.length > firstLine.length ? "…" : ""}`;

  // Same "### Heading" layout as the GitHub issue forms, so the label workflow
  // and anyone reading see one format.
  const parts = [
    "### Addon", "", r.addon, "",
    "### Type", "", label, "",
  ];
  if (r.type === "bug") parts.push("### Addon version", "", r.version || "_No response_", "");
  parts.push(r.type === "bug" ? "### What happened?" : "### Your idea", "", r.details, "");
  if (r.type === "bug" && r.errors) parts.push("### Error text", "", fenced(r.errors), "");
  parts.push("---", "_Sent from the support form at hotzip.dev._");

  return { title, body: parts.join("\n"), labels: [r.type, r.addon].filter((l) => l !== "Other") };
}

// ------------------------------------------------------------------ http

function send(res, status, data, origin) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin" };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

// Reads the request, up to LIMITS.body. A slightly too big report gets a clear
// answer; an absurd upload (10x the limit) is cut off.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > LIMITS.body * 10) { req.destroy(); return; }
      if (size <= LIMITS.body) chunks.push(c);
    });
    req.on("end", () => {
      if (size > LIMITS.body) { const e = new Error("too large"); e.tooLarge = true; return reject(e); }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// ------------------------------------------------------------------ GitHub auth

const GH_HEADERS = {
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "hotzip-support-relay",
};

function base64url(data) {
  return Buffer.from(data).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// A GitHub App proves who it is with a short JSON Web Token signed by its
// private key, then trades that for an installation token that lasts an hour.
function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: APP_ID }));
  const signature = crypto.createSign("RSA-SHA256").update(`${head}.${body}`).sign(APP_KEY);
  return `${head}.${body}.${base64url(signature)}`;
}

let cachedToken = null; // { token, expiresAt }

async function githubToken() {
  if (!USE_APP) return TOKEN;
  if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60 * 1000) return cachedToken.token;
  const res = await fetch(`${API}/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { ...GH_HEADERS, "Authorization": `Bearer ${appJwt()}` },
  });
  if (!res.ok) throw new Error(`app token request answered ${res.status}`);
  const data = await res.json();
  cachedToken = { token: data.token, expiresAt: Date.parse(data.expires_at) || Date.now() + 50 * 60 * 1000 };
  return cachedToken.token;
}

// GitHub silently drops labels on a new issue unless the creator can push to
// the repo. Our credential only has Issues access, so create first, then label.
async function createIssue({ labels, ...issue }) {
  const headers = { ...GH_HEADERS, "Authorization": `Bearer ${await githubToken()}`, "Content-Type": "application/json" };
  const res = await fetch(`${API}/repos/${REPO}/issues`, { method: "POST", headers, body: JSON.stringify(issue) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const data = await res.json();
  if (labels.length) {
    const lab = await fetch(`${API}/repos/${REPO}/issues/${data.number}/labels`, { method: "POST", headers, body: JSON.stringify({ labels }) });
    if (!lab.ok) console.error(`could not label the report: GitHub answered ${lab.status}`); // the report itself is in
  }
  return data.html_url;
}

async function handleReport(req, res, origin) {
  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch (e) {
    if (e.tooLarge) return send(res, 413, { error: "That report is too long. Shorten the error text and try again." }, origin);
    return send(res, 400, { error: "That didn't look like a report. Try again." }, origin);
  }
  if (!input || typeof input !== "object") return send(res, 400, { error: "That didn't look like a report." }, origin);

  // Honeypot: people never see this field. Bots that fill it get a quiet
  // "thanks" and nothing is created.
  if (String(input.website || "").trim() !== "") return send(res, 200, { ok: true }, origin);

  const r = {
    addon: String(input.addon || ""),
    type: String(input.type || ""),
    version: clean(input.version, LIMITS.version),
    details: clean(input.details, LIMITS.details),
    errors: clean(input.errors, LIMITS.errors),
  };
  if (!ADDONS.has(r.addon)) return send(res, 400, { error: "Pick an addon from the list." }, origin);
  if (!TYPES[r.type]) return send(res, 400, { error: "Pick Bug or Idea." }, origin);
  if (r.details.length < 5) return send(res, 400, { error: "Tell us a little more first." }, origin);

  if (!allowed(clientIp(req), Date.now())) {
    return send(res, 429, { error: "That's a lot of reports in a short time. Try again in an hour." }, origin);
  }

  try {
    const url = await createIssue(buildIssue(r));
    console.log(`report created (${r.type}, ${r.addon})`);
    return send(res, 201, { ok: true, url }, origin);
  } catch (e) {
    console.error("could not create issue:", e.message);
    return send(res, 502, { error: "Couldn't send right now. Try again in a few minutes." }, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = ORIGINS.includes(req.headers.origin) ? req.headers.origin : null;
  const path = (req.url || "/").split("?")[0];

  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });

  if (path !== "/report") return send(res, 404, { error: "Not found" }, origin);

  if (req.method === "OPTIONS") {
    if (!origin) { res.writeHead(403); return res.end(); }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    });
    return res.end();
  }

  if (req.method !== "POST") return send(res, 405, { error: "Use POST" }, origin);
  if (!origin) return send(res, 403, { error: "Not allowed" });

  try {
    await handleReport(req, res, origin);
  } catch (e) {
    console.error("unexpected error:", e.message);
    if (!res.headersSent) send(res, 500, { error: "Something went wrong. Try again later." }, origin);
  }
});

if (require.main === module) {
  if (!USE_APP && !TOKEN) console.warn("No GitHub App settings or GITHUB_TOKEN: reports will fail until one is set.");
  server.listen(PORT, () => console.log(`relay listening on ${PORT}, repo ${REPO}, auth ${USE_APP ? "github app" : "token"}, origins ${ORIGINS.join(" ")}`));
}

module.exports = { server, buildIssue, clean };
