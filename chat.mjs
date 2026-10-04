#!/usr/bin/env node
/*
 * chat.mjs — backend for the dashboard's chat window.
 *
 * Runs a private `kilo serve` and proxies a small slice of its HTTP/SSE API so
 * the browser can hold a conversation with an agent scoped to the folder open in
 * VSCodium. The extension already runs its own kilo server, but that one sits
 * behind basic auth and is shared with the editor; a private instance keeps the
 * dashboard independent and lets it serve any directory at once.
 *
 * Verified against kilo 7.8.1:
 *
 *   POST /api/session              {location:{directory}, model:{providerID,id}}
 *                                  -> {data:{id,...}}         create in any folder
 *   GET  /event?directory=<enc>    SSE, v1 opencode event shapes
 *   POST /session/:id/prompt_async {parts:[{type:"text",text}]}
 *   POST /session/:id/abort
 *   GET  /session/:id/message      full transcript, for backfill
 *   GET  /api/session/:id          {data:{location:{directory}}}
 *
 * Two things that silently do NOT work, both verified by probe:
 *
 *   - `POST /api/session/:id/prompt` (the v2 async endpoint) admits the prompt
 *     and then never schedules the agent loop. The v1 prompt_async does run it.
 *   - passing `agent` to session.create stalls the loop for a `build`/`code`
 *     name. Omitting it lets the server pick its default agent, which is what
 *     we want anyway since that agent allows every tool.
 *
 * Sessions land in kilo's shared global store, so `collector.mjs` picks up
 * chats made here and they show up on the dashboard like any other session.
 */

import { spawn } from "node:child_process";
import http from "node:http";
import { kiloBinOrFallback } from "./kilo-bin.mjs";

// Discovered rather than pinned — see kilo-bin.mjs. The private server, the
// collector and the extension all have to agree on the same CLI, because they
// share one session store.
const KILO_BIN = kiloBinOrFallback();

const DEFAULT_PORT = 9789;
// providerID first, then the model id: kilo lists its own ids with slashes in
// them ("kilo/kilo-auto/free"), and provider ids never contain a slash.
const DEFAULT_MODEL = "kilo/kilo-auto/free";
const HEALTH_WAIT_MS = 20000;

let server = null;      // { proc, port, ready }
let starting = null;    // in-flight promise, so concurrent callers share one boot

function base(port) {
  return "http://127.0.0.1:" + port;
}

// --- private kilo serve lifecycle -------------------------------------------

async function health(port) {
  return new Promise((done) => {
    const req = http.get(base(port) + "/global/health", (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on("error", () => done(false));
    req.setTimeout(2000, () => { req.destroy(); done(false); });
  });
}

async function boot(port) {
  const proc = spawn(KILO_BIN, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    windowsHide: true,
    stdio: "ignore",
  });
  proc.on("exit", () => { server = null; });

  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error("kilo serve exited " + proc.exitCode);
    if (await health(port)) {
      server = { proc, port, ready: true };
      return server;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error("kilo serve did not answer /global/health within " + HEALTH_WAIT_MS + "ms");
}

/** The private kilo server, booted on first use. */
export async function kiloServer() {
  if (server && server.ready) return server;
  if (!starting) {
    starting = boot(DEFAULT_PORT).finally(() => { starting = null; });
  }
  return starting;
}

export function stopKiloServer() {
  if (server && server.proc) server.proc.kill();
  server = null;
}

// --- HTTP client -------------------------------------------------------------

class KiloError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
  }
}

async function call(path, { method = "GET", body, port, timeoutMs = 120000 } = {}) {
  const p = port || (await kiloServer()).port;
  const payload = body === undefined ? null : JSON.stringify(body);
  const res = await fetch(base(p) + path, {
    method,
    headers: payload ? { "content-type": "application/json" } : {},
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  }
  if (!res.ok) {
    const detail = (data && (data.error || data.message)) || ("HTTP " + res.status);
    throw new KiloError(typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300), res.status);
  }
  return data;
}

// --- transcript shaping ------------------------------------------------------

function clip(s, n) {
  s = String(s == null ? "" : s).replace(/\r/g, "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Normalised into the same {r,k,t,tool,st,ts} shape collector.mjs writes, so the
// dashboard renders chat and replayed sessions with one code path.
export function normaliseMessages(raw, { chars = 4000 } = {}) {
  const out = [];
  for (const m of raw || []) {
    const info = m.info || {};
    const ts = info.time?.created || null;
    if (info.role === "user") {
      const body = (m.parts || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n\n");
      if (body.trim()) out.push({ r: "user", k: "text", t: clip(body, chars), ts });
      continue;
    }
    for (const p of m.parts || []) {
      if (p.type === "text" && String(p.text || "").trim()) {
        out.push({ r: "assistant", k: "text", t: clip(p.text, chars), ts });
      } else if (p.type === "reasoning" && String(p.text || "").trim()) {
        out.push({ r: "assistant", k: "reasoning", t: clip(p.text, Math.floor(chars / 2)), ts });
      } else if (p.type === "tool") {
        const st = p.state?.status || "unknown";
        const snip = st === "error" ? p.state?.error || p.state?.output : p.state?.output;
        out.push({
          r: "assistant",
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
  return out;
}

// --- kilo operations ---------------------------------------------------------

/** Create a chat session rooted at `directory`. */
export async function createSession({ directory, model = DEFAULT_MODEL }) {
  const [providerID, ...rest] = String(model).split("/");
  const data = await call("/api/session", {
    method: "POST",
    body: {
      location: { directory },
      model: { providerID, id: rest.join("/") },
    },
  });
  const s = data?.data;
  if (!s?.id) throw new KiloError("kilo created no session id");
  return { id: s.id, directory: s.location?.directory || directory, model: s.model || null, title: s.title || null };
}

/** Directory a session lives in — needed to scope its event stream. */
export async function sessionInfo(id) {
  const data = await call("/api/session/" + encodeURIComponent(id), { timeoutMs: 20000 });
  const s = data?.data || null;
  return s ? { id: s.id, directory: s.location?.directory || null, title: s.title || null, model: s.model || null } : null;
}

export async function sessionMessages(id, { limit = 200, chars = 4000 } = {}) {
  const raw = await call(`/session/${encodeURIComponent(id)}/message?limit=${limit}`, { timeoutMs: 60000 });
  return normaliseMessages(Array.isArray(raw) ? raw : raw?.data, { chars });
}

export async function sendPrompt(id, text) {
  await call(`/session/${encodeURIComponent(id)}/prompt_async`, {
    method: "POST",
    body: { parts: [{ type: "text", text }] },
    timeoutMs: 60000,
  });
}

export async function abortSession(id) {
  await call(`/session/${encodeURIComponent(id)}/abort`, { method: "POST", timeoutMs: 20000 });
}

/** Tool-capable models, so the picker cannot offer a chat-incapable model. */
export async function models() {
  const data = await call("/api/model", { timeoutMs: 60000 });
  return (data?.data || [])
    .filter((m) => m.capabilities?.tools && m.status !== "disabled")
    .map((m) => ({
      id: m.id,
      providerID: m.providerID,
      ref: m.providerID + "/" + m.id,
      name: m.name || m.id,
      cost: m.cost?.[0]?.input ?? null,
    }));
}

/**
 * Proxy one session's events to `res` as SSE.
 *
 * kilo's `/event` stream is directory-scoped and carries every session in that
 * directory, so events are filtered to `id` before they leave the server. Frames
 * are forwarded verbatim — the browser already knows how to render these parts
 * from the replay path, and re-shaping them here would mean two shapes to keep
 * in sync.
 */
export async function streamSession(res, id) {
  const info = await sessionInfo(id);
  if (!info || !info.directory) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "no such session, or it has no directory" }));
    return;
  }

  const { port } = await kiloServer();
  // The upstream is torn down through an AbortController, not body.cancel():
  // the `for await` below holds a reader lock on the body, and cancel() on a
  // locked stream throws ERR_INVALID_STATE from the close handler — which
  // crashes the whole server the moment a browser reloads the page.
  const upstreamCtl = new AbortController();
  let upstream;
  try {
    upstream = await fetch(
      `${base(port)}/event?directory=${encodeURIComponent(info.directory)}`,
      { headers: { accept: "text/event-stream" }, signal: upstreamCtl.signal }
    );
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "kilo event stream unreachable: " + e.message }));
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "kilo event stream refused the connection" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 2000\n\n`);
  res.write(`data: ${JSON.stringify({ type: "chat.open", properties: { sessionID: id, directory: info.directory } })}\n\n`);

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const decoder = new TextDecoder();
  let buf = "";
  let closed = false;

  res.on("close", () => { closed = true; upstreamCtl.abort(); });

  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let ev;
          try { ev = JSON.parse(raw); } catch { continue; }
          const sid = ev?.properties?.sessionID;
          if (sid !== id) continue;
          if (ev.type === "server.heartbeat") continue;
          send(ev);
        }
      }
      if (closed) break;
    }
  } catch {
    /* browser disconnected or the upstream was aborted; both are expected */
  }

  if (!res.writableEnded) {
    try {
      send({ type: "chat.closed", properties: { sessionID: id } });
      res.end();
    } catch {
      /* socket already gone */
    }
  }
}

export { KiloError, DEFAULT_MODEL };