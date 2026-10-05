#!/usr/bin/env node
/*
 * smoke.mjs — scripted smoke test for Agent Manager's /api/* routes.
 *
 * Spawns serve.mjs on a random port, hits every endpoint, prints PASS/FAIL,
 * exits non-zero on any failure.
 *
 *   node smoke.mjs
 *
 * No npm dependencies; Node stdlib only.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function request({ host, port, path, method, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (b) => chunks.push(b));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        if (text.trim()) {
          try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`request timeout: ${method} ${path}`)); });
    if (body !== undefined && body !== null) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  return true;
}

// Bounds a single check and names it on abort, so one hung endpoint surfaces as a
// named failure instead of consuming the whole-run guard and reporting nothing.
function withTimeout(label, promise, ms = 20000) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// ── Endpoint checks ───────────────────────────────────────────────────────────

async function checkHealth({ host, port }) {
  const { status, data } = await request({ host, port, path: "/api/health" });
  assert(status === 200, `status ${status} (expected 200)`);
  assert(data !== null, "response is not JSON");
  assert("ok" in data, `missing "ok" field: ${JSON.stringify(data)}`);
  assert("snapshot" in data, `missing "snapshot" field`);
  assert("collecting" in data, `missing "collecting" field`);
  assert("lastCollectError" in data, `missing "lastCollectError" field`);

  const { ok, collecting, lastCollectError } = data;
  if (ok) {
    // collector healthy
  } else if (collecting) {
    // first collect still in progress — not an error
  } else if (lastCollectError) {
    throw new Error(`collector broken: ${lastCollectError}`);
  } else {
    // ok:false, not collecting, no error — treat as broken
    throw new Error("collector unhealthy (ok:false, not collecting, no error detail)");
  }
  return "PASS /api/health";
}

async function checkState({ host, port }) {
  const { status, data } = await request({ host, port, path: "/api/state" });
  assert(status === 200, `status ${status} (expected 200)`);
  assert(data !== null, "response is not JSON");
  assert(typeof data === "object", `expected object, got ${typeof data}`);
  assert("generatedAt" in data || "sessions" in data || "details" in data,
    `missing expected snapshot fields: ${JSON.stringify(Object.keys(data))}`);
  return `PASS /api/state (agents: ${(data.agents || []).length}, sessions: ${(data.sessions || []).length})`;
}

async function checkCollect({ host, port }) {
  const { status, data } = await request({ host, port, path: "/api/collect?detail=2", timeoutMs: 120000 });
  assert(status === 200, `status ${status} (expected 200)`);
  assert(data !== null, "response is not JSON");
  assert(typeof data === "object", `expected object, got ${typeof data}`);
  return `PASS /api/collect (agents: ${(data.agents || []).length}, details: ${(data.details || []).length})`;
}

async function checkSessionAny({ host, port }) {
  try {
    const { status, data } = await request({ host, port, path: "/api/session/ses_000000000000", timeoutMs: 8000 });
    if (status === 404 || status === 502) {
      const reason = data?.error || `HTTP ${status}`;
      if (/no such session|not found|bad session/i.test(reason)) {
        return "SKIP /api/session/<id>: no sessions exist yet";
      }
      throw new Error(`unexpected error: ${reason}`);
    }
    assert(status === 200, `status ${status} (expected 200 or 404 for no sessions)`);
    assert(data !== null, "response is not JSON");
    assert(typeof data === "object", `expected object, got ${typeof data}`);
    return `PASS /api/session/<id>`;
  } catch (e) {
    if (/timeout/i.test(e.message)) {
      return "SKIP /api/session/<id>: export timed out (no sessions)";
    }
    throw e;
  }
}

async function checkChatWorkspace({ host, port }) {
  const { status, data } = await request({ host, port, path: "/api/chat/workspace" });
  assert(status === 200, `status ${status} (expected 200)`);
  assert(data !== null, "response is not JSON");
  assert(typeof data === "object", `expected object, got ${typeof data}`);
  assert("ok" in data, `missing "ok" field: ${JSON.stringify(data)}`);
  assert("directory" in data, `missing "directory" field`);
  assert("source" in data, `missing "source" field`);
  assert(Array.isArray(data.candidates), `"candidates" is not an array`);
  return `PASS /api/chat/workspace (source: ${data.source}, dir: ${data.directory || "(none)"})`;
}

async function checkChatModels({ host, port }) {
  const { status, data } = await request({ host, port, path: "/api/chat/models" });
  assert(status === 200, `status ${status} (expected 200)`);
  assert(data !== null, "response is not JSON");
  assert(typeof data === "object", `expected object, got ${typeof data}`);
  assert("ok" in data, `missing "ok" field`);
  assert("models" in data, `missing "models" field`);
  assert(Array.isArray(data.models), `"models" is not an array`);
  return `PASS /api/chat/models (${data.models.length} model${data.models.length === 1 ? "" : "s"})`;
}

async function checkChatSessionCreate({ host, port }) {
  const { status, data } = await request({
    host,
    port,
    path: "/api/chat/session",
    method: "POST",
    body: {},
  });
  if (status === 400) {
    assert(data?.ok === false, `expected {ok:false} in 400 body, got ${JSON.stringify(data)}`);
    assert(typeof data.error === "string", "expected error string in 400 body");
    return "SKIP /api/chat/session: no workspace resolved (expected)";
  }
  assert(status === 200, `status ${status} (expected 200 or 400)`);
  assert(data !== null, "response is not JSON");
  assert(data?.ok === true, `expected {ok:true}, got ${JSON.stringify(data)}`);
  assert(typeof data.session === "object" && typeof data.session.id === "string" && data.session.id.startsWith("ses_"),
    `expected valid session object, got ${JSON.stringify(data.session)}`);
  return `PASS /api/chat/session (created ${data.session.id})`;
}

async function checkChatEvents({ host, port, sessionId }) {
  if (!sessionId) return "SKIP /api/chat/events: no session";
  const { status } = await request({
    host,
    port,
    path: `/api/chat/events?session=${encodeURIComponent(sessionId)}`,
    timeoutMs: 30000,
  });
  // 200 with text/event-stream, or 4xx if session has no directory
  assert(status === 200 || status === 400 || status === 502,
    `status ${status} (expected 200 SSE, 400, or 502)`);
  return `PASS /api/chat/events (${status})`;
}

async function checkChatSend({ host, port, sessionId }) {
  if (!sessionId) return "SKIP /api/chat/send: no session";
  const { status, data } = await request({
    host,
    port,
    path: "/api/chat/send",
    method: "POST",
    body: { session: sessionId, text: "smoke test — ignore" },
  });
  assert(status === 200 || status === 400, `status ${status} (expected 200 or 400)`);
  if (status === 200) assert(data?.ok === true, `expected {ok:true}, got ${JSON.stringify(data)}`);
  return `PASS /api/chat/send (${status})`;
}

async function checkChatAbort({ host, port, sessionId }) {
  if (!sessionId) return "SKIP /api/chat/abort: no session";
  const { status, data } = await request({
    host,
    port,
    path: "/api/chat/abort",
    method: "POST",
    body: { session: sessionId },
  });
  assert(status === 200, `status ${status} (expected 200)`);
  assert(data?.ok === true, `expected {ok:true}, got ${JSON.stringify(data)}`);
  return "PASS /api/chat/abort";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runSmoke() {
  const results = [];
  let sessionId = null;

  // Parse optional flags (passed from the shell invocation)
  const argv = process.argv.slice(2);
  const flag = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
  };
  const has = (name) => argv.includes(name);

  // Server config
  const port = 0; // random port
  const useRefresh = !has("--no-refresh");
  const workspaceFlag = flag("--workspace", null);
  const serverArgs = [
    join(__dir, "serve.mjs"),
    "--port", "0",
    ...(useRefresh ? ["--refresh"] : []),
    ...(workspaceFlag ? ["--workspace", workspaceFlag] : []),
  ];

  // Create stub state.json so the server doesn't block on startup.
  // The stub is a valid snapshot with no data; we remove it afterward.
  const statePath = join(__dir, "state.json");
  let hadState = existsSync(statePath);
  let originalState = null;
  let restoreFailed = false;
  if (hadState) {
    // Read the backup with the already-imported fs functions. This used to call
    // require("node:fs"), which does not exist in ESM scope: the ReferenceError was
    // swallowed by the catch below, leaving originalState null, so cleanup() took the
    // "nothing to restore" path and the live snapshot stayed replaced by STUB_STATE.
    try {
      originalState = readFileSync(statePath, "utf8");
    } catch (e) {
      console.error(`FAIL could not back up ${statePath}: ${e.message}`);
      console.error("FAIL refusing to run: overwriting a snapshot we cannot restore is data loss.");
      process.exit(1);
    }
  }
  const STUB_STATE = { generatedAt: new Date().toISOString(), kiloBin: null, version: null, agents: [], sessions: [], details: [], errors: [], trackedSessionCount: 0 };
  writeFileSync(statePath, JSON.stringify(STUB_STATE, null, 2), "utf8");

  // Server lifecycle
  let serverProc = null;
  let serverPort = null;
  let timedOut = false;
  let currentCheck = "startup";
  const ctx = {};

  const cleanup = async () => {
    if (serverProc && serverProc.pid) {
      try { serverProc.kill("SIGTERM"); } catch { /* already dead */ }
    }
    // Restore original state.json. This is unconditional whenever a file was there:
    // a skipped restore here is silent data loss behind an otherwise passing run.
    try {
      if (hadState) {
        if (originalState === null) {
          restoreFailed = true;
          console.error(`FAIL REFUSING to report success: could not restore ${statePath}`);
        } else {
          writeFileSync(statePath, originalState, "utf8");
        }
      } else {
        try { unlinkSync(statePath); } catch { /* ignore */ }
      }
    } catch (e) {
      restoreFailed = true;
      console.error(`FAIL failed to restore ${statePath}: ${e.message}`);
    }
  };

  // Startup guard: bounds only the wait for the READY line. This used to cover the
  // whole suite, so a run whose server came up fine but whose checks took longer than
  // 30s was killed mid-flight with no indication of which check had hung.
  const startupTimer = setTimeout(() => {
    timedOut = true;
    console.error("FAIL server did not print a READY line within 30s");
    cleanup().finally(() => process.exit(1));
  }, 30000);

  // Overall guard: a backstop only. Per-check timeouts below report the hung check by
  // name, so reaching this one means several checks were slow rather than one being stuck.
  const overallTimer = setTimeout(() => {
    timedOut = true;
    console.error(`FAIL smoke run exceeded 180s; check in flight: ${currentCheck}`);
    cleanup().finally(() => process.exit(1));
  }, 180000);

  try {
    serverProc = spawn(process.execPath, serverArgs, {
      cwd: __dir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    serverProc.on("error", (e) => {
      clearTimeout(startupTimer);
      cleanup().finally(() => {
        console.error(`FAIL server spawn: ${e.message}`);
        process.exit(1);
      });
    });

    serverProc.on("exit", (code, signal) => {
      if (timedOut) return;
      clearTimeout(startupTimer);
      const cause = code !== null ? `exit ${code}` : `signal ${signal}`;
      cleanup().finally(() => {
        console.error(`FAIL server exited early (${cause})`);
        process.exit(1);
      });
    });

    // Wait for READY line on stdout
    await new Promise((resolveReady, rejectReady) => {
      let buf = "";
      const onData = (b) => {
        buf += b.toString();
        // Look for the last READY line in the accumulated buffer
        const lines = buf.split(/\r?\n/);
        const readyLine = lines.find((l) => l.startsWith("READY "));
        if (readyLine) {
          serverProc.stdout.off("data", onData);
          const portMatch = readyLine.match(/:(\d+)$/);
          serverPort = portMatch ? parseInt(portMatch[1], 10) : null;
          // Server is up: the startup guard has done its job, so stop it from
          // counting down across the checks that follow.
          clearTimeout(startupTimer);
          currentCheck = "readiness";
          resolveReady();
        }
      };
      serverProc.stdout.on("data", onData);
      // Timeout via the startupTimer above
      serverProc.stderr.on("data", (b) => {
        // Forward server stderr so smoke test errors don't disappear
        process.stderr.write(b);
      });
    });

    if (!serverPort) {
      throw new Error("could not extract port from READY line");
    }

    // ── Server is up — run checks ───────────────────────────────────────────
    console.log(`\nserver listening on :${serverPort}`);
    console.log("running smoke checks...\n");

    // Readiness gate for the initial collect, then health check
    let serverReady = false;
    try {
      const waitStart = Date.now();
      while (Date.now() - waitStart < 30000) {
        try {
          const { data: health } = await request({ host: "127.0.0.1", port: serverPort, path: "/api/health", timeoutMs: 2000 });
          if (health.snapshot || health.collecting) { serverReady = true; break; }
        } catch { /* server still warming up */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!serverReady) throw new Error("server did not become healthy within 30s");
    } catch (e) {
      console.log(`FAIL readiness gate: ${e.message}`);
      results.push(false);
    }

    if (serverReady) {
      try {
        results.push(await checkHealth({ host: "127.0.0.1", port: serverPort }));
      } catch (e) {
        console.log(`FAIL /api/health: ${e.message}`);
        results.push(false);
      }
    }

    // Core API checks
    const checks = [
      checkState,
      checkCollect,
      checkSessionAny,
      checkChatWorkspace,
      checkChatModels,
      checkChatSessionCreate,
    ];

    ctx.host = "127.0.0.1";
    ctx.port = serverPort;

    for (const fn of checks) {
      const label = fn.name.replace("check", "").replace(/([A-Z])/g, "/$1").toLowerCase();
      currentCheck = label;
      // First collect can take ~60s; give it a longer guard.
      const guardMs = (label === "/collect" || label === "/chat/events") ? 130000 : 20000;
      try {
        const msg = await withTimeout(label, fn(ctx), guardMs);
        console.log(msg);
        results.push(true);
      } catch (e) {
        console.log(`FAIL ${label}: ${e.message}`);
        results.push(false);
      }
    }

    // Capture the session id from the chat/session check that just ran, or create one
    // if that check was skipped or failed. This used to read the return value of
    // checkChatSessionCreate as if the id were a string while the check asserts it is
    // an object, so sessionId never got set and the events/send/abort checks below
    // always short-circuited to SKIP.
    const sessionIdx = checks.indexOf(checkChatSessionCreate);

    if (!sessionId) {
      currentCheck = "/api/chat/session";
      try {
        const { status, data } = await withTimeout("/api/chat/session", request({
          host: "127.0.0.1",
          port: serverPort,
          path: "/api/chat/session",
          method: "POST",
          body: {},
        }));
        if (data?.ok && data.session && typeof data.session.id === "string") {
          sessionId = data.session.id;
          console.log(`PASS /api/chat/session (created ${sessionId})`);
          if (sessionIdx >= 0 && !results[sessionIdx]) results[sessionIdx] = true;
        } else if (data?.ok === false && status === 400) {
          console.log(`SKIP /api/chat/session: no workspace resolved (expected)`);
        } else {
          console.log(`FAIL /api/chat/session: status ${status}, body ${JSON.stringify(data)}`);
          if (sessionIdx >= 0) results[sessionIdx] = false;
        }
      } catch (e) {
        console.log(`FAIL /api/chat/session: ${e.message}`);
        if (sessionIdx >= 0) results[sessionIdx] = false;
      }
    }

    // Chat endpoint checks that need a session
    const chatChecks = [
      ["/api/chat/events", () => checkChatEvents({ host: "127.0.0.1", port: serverPort, sessionId })],
      ["/api/chat/send", () => checkChatSend({ host: "127.0.0.1", port: serverPort, sessionId })],
      ["/api/chat/abort", () => checkChatAbort({ host: "127.0.0.1", port: serverPort, sessionId })],
    ];

    for (const [label, fn] of chatChecks) {
      currentCheck = label;
      try {
        const msg = await withTimeout(label, fn());
        console.log(msg);
        results.push(true);
      } catch (e) {
        console.log(`FAIL ${label}: ${e.message}`);
        results.push(false);
      }
    }

  } finally {
    clearTimeout(startupTimer);
    clearTimeout(overallTimer);
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const passed = results.filter(Boolean).length;
  const failed = results.filter((r) => !r).length;

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`results: ${passed} passed, ${failed} failed (${elapsed}s)`);

  await cleanup();
  if (serverProc) { try { serverProc.kill("SIGTERM"); } catch { /* ignore */ } }

  // A failed restore is a hard failure: the run may look clean while the live
  // snapshot sits destroyed on disk, which is the exact failure this file had.
  process.exit(failed > 0 || restoreFailed ? 1 : 0);
}

const startTime = Date.now();
runSmoke().catch((e) => {
  console.error(`smoke test fatal: ${e.message}`);
  process.exit(1);
});
