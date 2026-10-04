#!/usr/bin/env node
/*
 * agent-manager collector
 *
 * Polls the local Kilo CLI for agent + session state, exports the sessions that
 * matter, and derives subagent / task / tool-completion stats for the dashboard.
 *
 * Kilo's `task` tool writes child session ids into its output as
 *   <task id="ses_..." state="completed">
 * which is the only reliable parent -> subagent link, so we harvest it while
 * exporting and follow the chain to detail every descendant of a recent root.
 *
 * Usage:
 *   node collector.mjs [--detail N] [--max-sessions N] [--transcript N]
 *                      [--log-chars N] [--out state.json]
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kiloBin } from "./kilo-bin.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// Resolved, not pinned: the Kilo extension updates itself and renames its
// version folder, which used to leave the dashboard pointing at a deleted exe.
const KILO_BIN = kiloBin();

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DETAIL = parseInt(arg("--detail", "8"), 10);
const MAX_SESSIONS = parseInt(arg("--max-sessions", "500"), 10);
const MAX_DETAIL = Math.max(DETAIL * 5, 40);
const TRANSCRIPT = parseInt(arg("--transcript", "40"), 10);
const LOG_CHARS = parseInt(arg("--log-chars", "1200"), 10);
const OUT_PATH = resolve(arg("--out", resolve(__dir, "state.json")));
const CACHE_DIR = resolve(arg("--cache", resolve(__dir, ".cache")));

// bump when the derived shape changes so stale cache entries are not reused
const CACHE_VERSION = 2;

// Exporting a large session costs several seconds, so derived details are cached
// and only recomputed when the session's `updated` timestamp moves.
function cachePath(id) {
  return join(CACHE_DIR, id.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
}

function cacheRead(id, updatedAt) {
  const p = cachePath(id);
  if (!existsSync(p)) return null;
  try {
    const hit = JSON.parse(readFileSync(p, "utf8"));
    if (hit && hit.v === CACHE_VERSION && hit.updatedAt === updatedAt && hit.detail) return hit.detail;
  } catch {
    /* corrupt cache entry — fall through and re-export */
  }
  return null;
}

function cacheWrite(id, updatedAt, detail) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(id), JSON.stringify({ v: CACHE_VERSION, updatedAt, detail }), "utf8");
  } catch {
    /* cache is best-effort only */
  }
}

function cachePrune(liveIds) {
  try {
    if (!existsSync(CACHE_DIR)) return;
    for (const f of readdirSync(CACHE_DIR)) {
      if (f.endsWith(".json") && !liveIds.has(f.replace(/\.json$/, ""))) {
        unlinkSync(join(CACHE_DIR, f));
      }
    }
  } catch {
    /* best-effort */
  }
}

// run a kilo subcommand and return trimmed stdout; throws with stderr on failure
function run(args) {
  const r = spawnSync(KILO_BIN, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  const out = (r.stdout || "").trim();
  if (!out && r.status !== 0) {
    throw new Error(`${args.join(" ")} exited ${r.status}: ${(r.stderr || "").trim().slice(0, 300)}`);
  }
  return out;
}

// kilo prints the ascii banner on stdout before json, so slice to the first brace
function parseJson(text) {
  const start = text.search(/[\[{]/);
  if (start < 0) throw new Error("no JSON in output");
  return JSON.parse(text.slice(start));
}

// `agent list` prints "<name> (<mode>)" lines each followed by a permission blob
function parseAgents(text) {
  const agents = [];
  const re = /^(\S+)\s+\((primary|subagent|all)\)/gm;
  let m;
  while ((m = re.exec(text))) agents.push({ name: m[1], mode: m[2] });
  return agents;
}

function listSessions() {
  const raw = run(["session", "list", "--format", "json", "-a", "-n", String(MAX_SESSIONS)]);
  const arr = parseJson(raw);
  return arr.map((s) => ({
    id: s.id,
    title: s.title || s.id,
    updatedAt: s.updated || null,
    createdAt: s.created || null,
    directory: s.directory || null,
    projectId: s.projectId || null,
  }));
}

const FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|css|html|json|md|ya?ml|toml|sh|ps1)$/i;

// transcript entries stay small: state.json holds one of these per tracked session,
// so long text is clipped and flagged rather than dropped silently
function clip(value, max) {
  const s = String(value == null ? "" : value).replace(/\r/g, "");
  return s.length > max ? { t: s.slice(0, max), trunc: true } : { t: s, trunc: false };
}

function analyzeSession(id) {
  const data = parseJson(run(["export", id]));
  const info = data.info || {};
  const messages = data.messages || [];

  const out = {
    id,
    title: info.title || null,
    agent: info.agent || null,
    mode: info.mode || null,
    model: info.model ? `${info.model.providerID || ""}/${info.model.id || ""}`.replace(/^\//, "") : null,
    directory: info.directory || null,
    createdAt: info.time?.created || null,
    updatedAt: info.time?.updated || null,
    tokens: info.tokens || null,
    cost: info.cost || 0,
    summary: info.summary || null,
    messages: messages.length,
    tools: { total: 0, completed: 0, error: 0, running: 0, pending: 0, byType: {} },
    tasks: [],
    filesTouched: [],
    lastText: null,
    lastTool: null,
    lastToolStatus: null,
    log: [],
    error: null,
  };

  const files = new Set();
  const log = out.log;

  for (const m of messages) {
    const ts = m.info?.time?.created || null;
    const role = m.info?.role || "assistant";

    if (role === "user") {
      const body = (m.parts || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n\n");
      const c = clip(body, LOG_CHARS);
      if (c.t.trim()) log.push({ r: "user", k: "text", t: c.t, tr: c.trunc, ts });
      continue;
    }

    for (const p of m.parts || []) {
      if (p.type === "text") {
        const c = clip(p.text, LOG_CHARS);
        const t = c.t.replace(/\s+/g, " ").trim();
        if (t) out.lastText = t.slice(0, 400);
        if (c.t.trim()) log.push({ r: role, k: "text", t: c.t, tr: c.trunc, ts });
      } else if (p.type === "reasoning") {
        const c = clip(p.text, Math.floor(LOG_CHARS / 2));
        if (c.t.trim()) log.push({ r: role, k: "reasoning", t: c.t, tr: c.trunc, ts });
      } else if (p.type === "tool") {
        const name = p.tool || "unknown";
        const st = p.state?.status || "unknown";
        out.tools.total++;
        if (st === "completed") out.tools.completed++;
        else if (st === "error") out.tools.error++;
        else if (st === "running") out.tools.running++;
        else out.tools.pending++;
        out.tools.byType[name] = (out.tools.byType[name] || 0) + 1;

        // tool detail line: the call summary plus a peek at its output, which is
        // usually what you want when you are asking "what is it doing right now"
        const head = p.state?.title || name;
        const snippet =
          st === "error"
            ? String(p.state?.error || p.state?.output || "")
            : String(p.state?.output || "");
        const c = clip(snippet.replace(/\s+/g, " ").trim(), Math.floor(LOG_CHARS / 2));
        log.push({ r: role, k: "tool", tool: name, st, t: head, o: c.t, tr: c.trunc, ts });

        out.lastTool = p.state?.title || name;
        out.lastToolStatus = st;

        if (name === "task") {
          const m2 = String(p.state?.output || "").match(/<task id="([^"]+)" state="([^"]+)"/);
          out.tasks.push({
            childId: m2 ? m2[1] : null,
            state: m2 ? m2[2] : st,
            subagentType: p.state?.input?.subagent_type || p.state?.input?.description || null,
            description: p.state?.input?.description || null,
          });
        }

        for (const v of Object.values(p.state?.input || {})) {
          if (typeof v === "string" && FILE_EXT.test(v) && v.length < 260) files.add(v);
        }
      }
    }
  }

  out.filesTouched = [...files].slice(0, 60);
  // keep the tail of the conversation: that is the current state of the work
  out.logTruncated = log.length > TRANSCRIPT;
  out.log = log.slice(-TRANSCRIPT);
  return out;
}

// ---- main ----
const data = {
  generatedAt: new Date().toISOString(),
  kiloBin: KILO_BIN,
  version: null,
  agents: [],
  sessions: [],
  details: [],
  errors: [],
};

const fail = (label, e) => data.errors.push(`${label}: ${e && e.message ? e.message : e}`);

if (!KILO_BIN) {
  fail("kilo", new Error(
    "kilo CLI not found. Install the Kilo Code extension, or set $env:KILO_BIN to its bin\\kilo.exe"
  ));
}

try {
  data.version = run(["--version"]).split(/\s/).pop();
} catch (e) {
  fail("version", e);
}

try {
  data.agents = parseAgents(run(["agent", "list"]));
} catch (e) {
  fail("agents", e);
}

try {
  data.sessions = listSessions();
} catch (e) {
  fail("sessions", e);
}

// Seed with the most recently updated sessions, then walk into every subagent
// they spawned so the dashboard can show the whole tree at once.
const byId = new Map(data.sessions.map((s) => [s.id, s]));
const sorted = [...data.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
const queue = sorted.slice(0, DETAIL).map((s) => s.id);
const seen = new Set();
const details = [];

while (queue.length && details.length < MAX_DETAIL) {
  const id = queue.shift();
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const meta = byId.get(id);
  try {
    const cached = cacheRead(id, meta ? meta.updatedAt : null);
    const d = cached || analyzeSession(id);
    if (!cached) cacheWrite(id, meta ? meta.updatedAt : null, d);
    d.parentId = null; // filled in below from any parent that references it
    d.title = d.title || byId.get(id)?.title || id;
    d.directory = d.directory || byId.get(id)?.directory || null;
    d.updatedAt = d.updatedAt || byId.get(id)?.updatedAt || null;
    details.push(d);
    for (const t of d.tasks) {
      if (t.childId && !seen.has(t.childId)) queue.push(t.childId);
    }
  } catch (e) {
    details.push({ id, title: byId.get(id)?.title || id, error: String(e.message || e) });
  }
}

const detailIds = new Set(details.map((d) => d.id));

// link children back to their parent so the UI can nest them
const detailById = new Map(details.map((d) => [d.id, d]));
for (const d of details) {
  d.children = [];
  for (const t of d.tasks) {
    if (!t.childId) continue;
    const child = detailById.get(t.childId);
    t.childTitle = child ? child.title : t.description || t.childId;
    t.detailCaptured = Boolean(child);
    if (child && child !== d) {
      child.parentId = d.id;
      if (!d.children.includes(child.id)) d.children.push(child.id);
    }
  }
  d.tasks.sort((a, b) => (a.state === "completed" ? 1 : 0) - (b.state === "completed" ? 1 : 0));
}

data.details = details;
data.trackedSessionCount = detailIds.size;

if (process.argv.includes("--prune-cache")) cachePrune(new Set(data.sessions.map((s) => s.id)));

writeFileSync(OUT_PATH, JSON.stringify(data, null, 2), "utf8");

const tasks = details.reduce((n, d) => n + (d.tasks ? d.tasks.length : 0), 0);
const done = details.reduce(
  (n, d) => n + (d.tasks ? d.tasks.filter((t) => t.state === "completed").length : 0),
  0
);
const running = details.filter((d) => d.lastToolStatus === "running").length;

console.log(
  JSON.stringify({
    out: OUT_PATH,
    version: data.version,
    agents: data.agents.length,
    sessions: data.sessions.length,
    details: details.length,
    tasks,
    tasksCompleted: done,
    running,
    errors: data.errors.length
  })
);
if (data.errors.length) for (const e of data.errors) console.error("  ! " + e);