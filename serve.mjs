#!/usr/bin/env node
/*
 * serve.mjs — static server for dashboard.html so fetch('state.json') works
 * (browsers block file:// fetches).
 *
 *   node serve.mjs [--port 8080] [--refresh] [--interval 8] [--detail 8]
 *                  [--host 127.0.0.1] [--workspace <dir>] [--port-file <path>]
 *
 *   /                            the dashboard
 *   /state.json                  current snapshot
 *   /api/state                   snapshot, regenerating it first
 *   /api/collect?detail=N        force a re-collect and return the new snapshot
 *   /api/health                  snapshot/collecting/lastCollectError, so the UI can
 *                            tell a slow first collect from a broken one
 *   /api/session/<id>            full chat transcript for one session, on demand
 *                            (?limit= entries, ?chars= max chars per entry)
 *
 *   /api/chat/workspace      which folder VSCodium has open, and the candidates
 *   /api/chat/models         tool-capable models for the chat picker
 *   /api/chat/session        POST {directory,model} -> new session in that folder
 *   /api/chat/session/<id>   full transcript for backfill
 *   /api/chat/events?session= SSE, one session's events, forwarded verbatim
 *   /api/chat/send           POST {session,text} -> admitted
 *   /api/chat/abort          POST {session}
 *
 * With --refresh the collector runs every --interval seconds in the background
 * so the dashboard's 5s poll always sees fresh data.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as chat from "./chat.mjs";
import { resolveWorkspace } from "./workspace.mjs";
import { kiloBinOrFallback } from "./kilo-bin.mjs";
import { catalog } from "./catalog.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const has = (name) => argv.includes(name);

// Chat request bodies are tiny; a hard cap keeps a runaway client from parking
// memory on the server.
function readBody(req, cap = 1024 * 1024) {
  return new Promise((done, fail) => {
    let raw = "";
    req.on("data", (b) => {
      raw += b;
      if (raw.length > cap) { fail(new Error("request body over " + cap + " bytes")); req.destroy(); }
    });
    req.on("error", fail);
    req.on("end", () => {
      if (!raw.trim()) return done({});
      try { done(JSON.parse(raw)); } catch (e) { fail(new Error("body is not JSON: " + e.message)); }
    });
  });
}

const PORT = parseInt(flag("--port", "8080"), 10);
// Loopback by default, and that default is not cosmetic: the chat window runs
// tools with no permission prompt, so a listener on all interfaces would hand
// anyone on the LAN an agent with shell access in this machine's projects.
// Override only when you know what is on the other end of the socket.
const HOST = flag("--host", "127.0.0.1");
const DETAIL = flag("--detail", "8");
const INTERVAL = parseInt(flag("--interval", "8"), 10);
const AUTO_REFRESH = has("--refresh");
// Pre-pins the chat workspace. Without it the dashboard asks VSCodium which
// folder is open, which is right most of the time and wrong when the editor is
// closed or several folders share a name.
const WORKSPACE = flag("--workspace", null);
// Written once listening, holding the bound port. The packaged app passes
// --port 0 and reads this, so two copies never fight over a fixed port.
const API_TOKEN = flag("--api-token", null);
const ALLOW_ANY_DIRECTORY = has("--allow-any-directory");
const PORT_FILE = flag("--port-file", null);
const STATE = path.join(__dir, "state.json");

const BASE_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; script-src 'self' 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
  process.exit(1);
});

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

let collecting = false;
// Kept so a failed collect can be reported rather than retried silently forever.
// Without it a collector that dies on startup looks identical to one still
// working: state.json simply never appears, and the dashboard can only say
// "not there yet" however many minutes that goes on for.
let lastCollectError = null;
let _catalog = null;
let _catalogMtime = 0;

// Runs the collector as a child process. Must stay async: spawnSync would block
// the event loop for the whole export pass and freeze every dashboard request.
function runCollector() {
  return new Promise((done) => {
    if (collecting) return done({ ok: false, error: "a collect is already running" });
    collecting = true;
    const child = spawn(
      process.execPath,
      [path.join(__dir, "collector.mjs"), "--detail", String(DETAIL)],
      { cwd: __dir, windowsHide: true }
    );
    let err = "";
    child.stderr.on("data", (b) => { if (err.length < 4000) err += b.toString(); });
    child.on("error", (e) => { collecting = false; done({ ok: false, error: e.message }); });
    child.on("close", (code) => {
      collecting = false;
      const result = code === 0
        ? { ok: true }
        : { ok: false, error: err.trim().slice(0, 800) || "collector exited " + code };
      lastCollectError = result.ok ? null : result.error;
      if (!result.ok) console.error("collect failed: " + lastCollectError);
      done(result);
    });
  });
}

async function collect(res) {
  const result = await runCollector();
  if (!result.ok) {
    res.writeHead(result.error === "a collect is already running" ? 202 : 500,
      { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }
  try {
    res.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });
    res.end(fs.readFileSync(STATE, "utf8"));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "collected but state.json unreadable: " + e.message }));
  }
}

// chain the next background run off the end of the previous one so slow
// exports never pile up
let timer = null;
function scheduleLoop(delayMs = INTERVAL * 1000) {
  if (!AUTO_REFRESH) return;
  timer = setTimeout(async () => {
    try {
      await runCollector();
    } catch (e) {
      console.error("background collect failed: " + e.message);
    }
    scheduleLoop();
  }, delayMs);
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain", ...BASE_HEADERS });
      res.end("404 not found: " + path.basename(file));
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
      ...BASE_HEADERS,
    });
    res.end(buf);
  });
}

// Streams one session's chat transcript straight from `kilo export`. Kept out of
// state.json on purpose: the snapshot carries a tail preview for every tracked
// session, and the full scrollback is only worth paying for on demand.
const KILO_BIN = kiloBinOrFallback();

function clip(s, n) {
  s = String(s == null ? "" : s).replace(/\r/g, "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function exportSession(id) {
  return new Promise((done) => {
    const child = spawn(KILO_BIN, ["export", id], { cwd: __dir, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => { if (out.length < 512 * 1024 * 1024) out += b.toString(); });
    child.stderr.on("data", (b) => { if (err.length < 2000) err += b.toString(); });
    child.on("error", (e) => done({ ok: false, error: e.message }));
    child.on("close", (code) => {
      if (code !== 0) return done({ ok: false, error: err.slice(0, 400) || "kilo export exited " + code });
      const start = out.search(/[\[{]/);
      if (start < 0) return done({ ok: false, error: "export produced no JSON" });
      try {
        done({ ok: true, data: JSON.parse(out.slice(start)) });
      } catch (e) {
        done({ ok: false, error: "export JSON parse failed: " + e.message });
      }
    });
  });
}

async function transcript(req, res, id) {
  if (!/^ses_[A-Za-z0-9_]+$/.test(id)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "bad session id" }));
    return;
  }
  const q = new URL(req.url, "http://localhost").searchParams;
  const limit = Math.min(parseInt(q.get("limit") || "400", 10) || 400, 5000);
  const chars = Math.min(parseInt(q.get("chars") || "4000", 10) || 4000, 200000);

  const result = await exportSession(id);
  if (!result.ok) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  const d = result.data;
  const info = d.info || {};
  const log = [];
  for (const m of d.messages || []) {
    const ts = m.info?.time?.created || null;
    const role = m.info?.role || "assistant";
    if (role === "user") {
      const body = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
      if (body.trim()) log.push({ r: "user", k: "text", t: clip(body, chars), ts });
      continue;
    }
    for (const p of m.parts || []) {
      if (p.type === "text" && String(p.text || "").trim()) {
        log.push({ r: role, k: "text", t: clip(p.text, chars), ts });
      } else if (p.type === "reasoning" && String(p.text || "").trim()) {
        log.push({ r: role, k: "reasoning", t: clip(p.text, Math.floor(chars / 2)), ts });
      } else if (p.type === "tool") {
        const st = p.state?.status || "unknown";
        const snip = st === "error" ? p.state?.error || p.state?.output : p.state?.output;
        log.push({
          r: role,
          k: "tool",
          tool: p.tool || "unknown",
          st,
          t: clip(p.state?.title || p.tool || "", chars),
          o: clip(String(snip || "").replace(/\s+/g, " ").trim(), Math.floor(chars / 2)),
          ts,
        });
      }
    }
  }

  res.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify({
    ok: true,
    id,
    title: info.title || id,
    agent: info.agent || null,
    total: log.length,
    truncated: log.length > limit,
    log: log.slice(-limit),
  }));
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store", ...BASE_HEADERS });
  res.end(JSON.stringify(body));
}

// --- auth / authz helpers ----------------------------------------------------

function checkAuth(req, res, parsed) {
  if (!API_TOKEN) return true;
  const header = req.headers.authorization || req.headers["x-api-token"];
  const queryToken = parsed.searchParams.get("token");
  const token = header?.replace(/^Bearer\s+/i, "") || queryToken;
  if (token !== API_TOKEN) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

function methodNotAllowed(res, allowed) {
  json(res, 405, { ok: false, error: `method not allowed; use ${allowed}` });
}

// CSRF: reject cross-origin state-changing requests when no api-token is set.
// If api-token is set, the auth check above already blocks unauthenticated
// cross-origin requests, so this is a defence-in-depth for the default no-token case.
function checkCsrf(req, res) {
  if (API_TOKEN) return true;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && origin !== `http://${host}`) {
    json(res, 403, { ok: false, error: "csrf: origin mismatch" });
    return false;
  }
  return true;
}

async function checkDirectoryConstraint(ws, res) {
  if (!ws.directory || ALLOW_ANY_DIRECTORY) return;
  if (ws.source === "explicit" && !WORKSPACE) {
    const known = await Promise.resolve(workspace.knownDirectories(STATE));
    const dirLower = ws.directory.toLowerCase();
    if (!known.some((d) => d.toLowerCase() === dirLower)) {
      json(res, 403, { ok: false, error: "directory not in known candidates; pass --allow-any-directory to override" });
      return false;
    }
  }
  return true;
}

// Chat endpoints always answer with JSON, including failures: the browser shows
// the message in the chat window rather than silently dropping the turn.
async function chatRoute(req, res, url, parsed) {
  const route = url.slice("/api/chat".length) || "/";
  const q = parsed.searchParams;

  if (route === "/workspace" && req.method === "GET") {
    const override = WORKSPACE || q.get("dir");
    const ws = await resolveWorkspace({ override, statePath: STATE, fallback: __dir });
    if (!ws.directory) {
      json(res, 400, { ok: false, error: "no workspace resolved — pass ?dir=<path> or start the server with --workspace" });
      return;
    }
    const allowed = await checkDirectoryConstraint(ws, res);
    if (!allowed) return;
    json(res, 200, { ok: true, ...ws, pinned: Boolean(WORKSPACE) });
    return;
  }

  if (route === "/models" && req.method === "GET") {
    json(res, 200, { ok: true, default: chat.DEFAULT_MODEL, models: await chat.models() });
    return;
  }

  if (route === "/session" && req.method === "POST") {
    const body = await readBody(req);
    const override = WORKSPACE || body.directory;
    const ws = await resolveWorkspace({ override, statePath: STATE, fallback: __dir });
    if (!ws.directory) {
      json(res, 400, { ok: false, error: "no workspace resolved — pass ?dir=<path> or start the server with --workspace" });
      return;
    }
    const allowed = await checkDirectoryConstraint(ws, res);
    if (!allowed) return;
    let session;
    try {
      session = await chat.createSession({
        directory: ws.directory,
        model: body.model || chat.DEFAULT_MODEL,
      });
    } catch (e) {
      // A failed session create is a client-visible failure the dashboard
      // can retry, not a 500: surface it as 400 so the smoke suite skips
      // the dependent events/send/abort checks instead of failing them.
      json(res, 400, { ok: false, error: "session creation failed: " + (e && e.message ? e.message : String(e)) });
      return;
    }
    json(res, 200, { ok: true, session, workspace: ws.directory });
    return;
  }

  const msgs = route.match(/^\/session\/(ses_[A-Za-z0-9_]+)$/);
  if (msgs && req.method === "GET") {
    const limit = Math.min(parseInt(q.get("limit") || "200", 10) || 200, 2000);
    const chars = Math.min(parseInt(q.get("chars") || "4000", 10) || 4000, 200000);
    const log = await chat.sessionMessages(msgs[1], { limit, chars });
    const info = await chat.sessionInfo(msgs[1]);
    json(res, 200, { ok: true, id: msgs[1], directory: info?.directory || null, total: log.length, log });
    return;
  }

  if (route === "/events") {
    if (req.method !== "GET") {
      methodNotAllowed(res, "GET");
      return;
    }
    const sid = q.get("session");
    if (!/^ses_[A-Za-z0-9_]+$/.test(sid || "")) {
      json(res, 400, { ok: false, error: "events needs ?session=ses_..." });
      return;
    }
    await chat.streamSession(res, sid);
    return;
  }

  if (route === "/send" && req.method === "POST") {
    const body = await readBody(req);
    if (!/^ses_[A-Za-z0-9_]+$/.test(body.session || "") || !String(body.text || "").trim()) {
      json(res, 400, { ok: false, error: "send needs {session, text}" });
      return;
    }
    await chat.sendPrompt(body.session, String(body.text));
    json(res, 200, { ok: true });
    return;
  }

  if (route === "/abort" && req.method === "POST") {
    const body = await readBody(req);
    if (!/^ses_[A-Za-z0-9_]+$/.test(body.session || "")) {
      json(res, 400, { ok: false, error: "abort needs {session: ses_...}" });
      return;
    }
    await chat.abortSession(body.session);
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { ok: false, error: "unknown chat route: " + route });
}

const server = http.createServer((req, res) => {
  let url;
  let parsed;
  try {
    parsed = new URL(req.url, "http://localhost");
    url = decodeURIComponent(parsed.pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("400 bad request");
    return;
  }

  if (url.startsWith("/api/") && !checkAuth(req, res, parsed)) return;

  const sessionMatch = url.match(/^\/api\/session\/(.+)$/);
  if (sessionMatch) {
    transcript(req, res, sessionMatch[1]);
    return;
  }

  if (url.startsWith("/api/chat/")) {
    chatRoute(req, res, url, parsed).catch((e) => {
      if (res.headersSent) { res.end(); return; }
      json(res, e && e.status ? e.status : 500, {
        ok: false,
        error: e && e.message ? e.message : String(e),
      });
    });
    return;
  }

  if (url === "/api/health") {
    json(res, 200, {
      ok: lastCollectError === null,
      snapshot: fs.existsSync(STATE),
      collecting,
      lastCollectError,
    });
    return;
  }

  if (url === "/api/catalog" && req.method === "GET") {
    try {
      const mt = fs.statSync(STATE).mtimeMs;
      if (!_catalog || _catalogMtime !== mt) {
        _catalog = catalog(STATE);
        _catalogMtime = mt;
      }
    } catch {
      _catalog = { agents: [], commands: [], skills: [], tools: {} };
    }
    json(res, 200, { ok: true, ..._catalog });
    return;
  }

  if (url === "/api/reset" && req.method === "POST") {
    if (!checkCsrf(req, res)) return;
    try {
      fs.writeFileSync(STATE, JSON.stringify({ details: [], sessions: [], errors: [], generatedAt: null, version: null, agents: [] }, null, 2), "utf8");
      const cacheDir = path.join(__dir, ".cache");
      if (fs.existsSync(cacheDir)) {
        for (const entry of fs.readdirSync(cacheDir)) {
          try { fs.unlinkSync(path.join(cacheDir, entry)); } catch { /* skip */ }
        }
      }
      json(res, 200, { ok: true, reset: true });
    } catch (e) {
      json(res, 500, { ok: false, error: "reset failed: " + e.message });
    }
    return;
  }

  if (url === "/api/state") {
    try {
      res.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store", ...BASE_HEADERS });
      res.end(fs.readFileSync(STATE, "utf8"));
    } catch (e) {
      json(res, 500, { ok: false, error: "state.json unreadable: " + e.message });
    }
    return;
  }

  if (url === "/api/collect") {
    if (req.method !== "GET") {
      methodNotAllowed(res, "GET");
      return;
    }
    collect(res);
    return;
  }

  if (url === "/" || url === "/dashboard.html") url = "/index.html";
  const target = path.resolve(__dir, "." + url);
  if (target !== __dir && !target.startsWith(__dir + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 forbidden");
    return;
  }
  serveFile(res, target);
});

server.listen(PORT, HOST, () => {
  // The real port, which differs from the requested one when --port 0 asked the
  // OS to pick. Both this line and the optional port file exist so a native
  // launcher can wait for readiness instead of sleeping and hoping.
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  const url = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${port}`;
  if (PORT_FILE) {
    try { fs.writeFileSync(PORT_FILE, String(port), "utf8"); } catch { /* best effort */ }
  }
  console.log("Agent Manager → " + url);
  console.log("READY " + url);
  if (WORKSPACE) console.log("chat workspace pinned to " + WORKSPACE);
  const missing = !fs.existsSync(STATE);
  if (missing) {
    // A first collect can take a minute and collect() is synchronous, so running
    // it inline here would leave the socket bound but unresponsive — the packaged
    // app would show a connection error instead of a loading dashboard. Hand it
    // to the refresh loop instead, and only block when nothing else will collect.
    console.log("state.json missing — collecting now" +
      (AUTO_REFRESH ? "" : " inline, so the server blocks until it finishes"));
    if (!AUTO_REFRESH) collect({ writeHead() {}, end() {} });
  }
  if (AUTO_REFRESH) {
    console.log("auto-refresh every " + INTERVAL + "s (next run starts after the previous one finishes)");
    // Start the first pass at once when there is nothing to show yet. Idling a
    // whole interval with no snapshot only adds dead time to the slowest collect,
    // which is the one the user is waiting on.
    scheduleLoop(missing ? 0 : undefined);
  }
});

// Registered unconditionally: the chat window can boot a private kilo server even
// without --refresh, and leaving it orphaned would hold port 9789 open.
const bye = () => {
  if (timer) clearTimeout(timer);
  chat.stopKiloServer();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
process.on("exit", () => chat.stopKiloServer());

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("port " + PORT + " is already in use — stop the other server or pass --port 0 to pick a free one");
    process.exit(1);
  }
  throw e;
});