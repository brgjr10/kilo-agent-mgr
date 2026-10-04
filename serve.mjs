#!/usr/bin/env node
/*
 * serve.mjs — static server for dashboard.html so fetch('state.json') works
 * (browsers block file:// fetches).
 *
 *   node serve.mjs [--port 8080] [--refresh] [--interval 8] [--detail 8]
 *
 *   /dashboard.html          the dashboard
 *   /state.json              current snapshot
 *   /api/state               snapshot, regenerating it first
 *   /api/collect?detail=N    force a re-collect and return the new snapshot
 *   /api/session/<id>        full chat transcript for one session, on demand
 *                            (?limit= entries, ?chars= max chars per entry)
 *
 * With --refresh the collector runs every --interval seconds in the background
 * so the dashboard's 5s poll always sees fresh data.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const has = (name) => argv.includes(name);

const PORT = parseInt(flag("--port", "8080"), 10);
const DETAIL = flag("--detail", "8");
const INTERVAL = parseInt(flag("--interval", "8"), 10);
const AUTO_REFRESH = has("--refresh");
const STATE = path.join(__dir, "state.json");

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
      done(code === 0 ? { ok: true } : { ok: false, error: err.slice(0, 800) || "collector exited " + code });
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
function scheduleLoop() {
  if (!AUTO_REFRESH) return;
  timer = setTimeout(async () => {
    await runCollector();
    scheduleLoop();
  }, INTERVAL * 1000);
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 not found: " + path.basename(file));
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}

// Streams one session's chat transcript straight from `kilo export`. Kept out of
// state.json on purpose: the snapshot carries a tail preview for every tracked
// session, and the full scrollback is only worth paying for on demand.
const KILO_BIN = process.env.KILO_BIN ||
  "C:\\Users\\brgjr\\.vscode-oss\\extensions\\kilocode.kilo-code-7.8.1-win32-x64\\bin\\kilo.exe";

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
  if (!/^ses_[A-Za-z0-9]+$/.test(id)) {
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

  const sessionMatch = url.match(/^\/api\/session\/(.+)$/);
  if (sessionMatch) {
    transcript(req, res, sessionMatch[1]);
    return;
  }

  if (url === "/api/state" || url === "/api/collect") {
    collect(res);
    return;
  }

  if (url === "/" || url === "/index.html") url = "/dashboard.html";
  const target = path.resolve(__dir, "." + url);
  if (target !== __dir && !target.startsWith(__dir + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 forbidden");
    return;
  }
  serveFile(res, target);
});

server.listen(PORT, () => {
  console.log("Agent Manager → http://localhost:" + PORT);
  if (!fs.existsSync(STATE)) {
    console.log("state.json missing — collecting now (first run can take a minute) …");
    collect({ writeHead() {}, end() {} });
  }
  if (AUTO_REFRESH) {
    console.log("auto-refresh every " + INTERVAL + "s (next run starts after the previous one finishes)");
    scheduleLoop();
    const bye = () => { if (timer) clearTimeout(timer); server.close(() => process.exit(0)); };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("port " + PORT + " is already in use — stop the other server or pass --port 8081");
    process.exit(1);
  }
  throw e;
});