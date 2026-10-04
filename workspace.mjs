#!/usr/bin/env node
/*
 * workspace.mjs — resolve "whichever folder is open in VSCodium".
 *
 * Three sources, most authoritative first. Every one of them can be absent, so
 * resolution degrades instead of failing:
 *
 *   1. explicit  — a --workspace flag or ?dir= from the dashboard
 *   2. window    — the live VSCodium window title, which carries the open folder
 *                  name but not its path
 *   3. stored    — globalStorage/storage.json, which remembers the last folder
 *                  VSCodium shut down with
 *
 * The window title is the only *live* signal. It gives a bare folder name
 * ("agent-manager - VSCodium"), never a path, so it is resolved against the
 * directories the collector already knows about. If several projects share a
 * folder name the caller is told, because guessing wrong means the agent works
 * in the wrong tree.
 *
 * storage.json is only flushed on shutdown, so on its own it can be days stale —
 * it is a fallback, never the primary.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const WINDOW_TTL_MS = 5000;
let windowCache = { at: 0, value: null };

// `file://zimaserver/share/x` -> `\\zimaserver\share\x`; `file:///C:/x` -> `C:\x`
function fromFileUri(uri) {
  let s = String(uri || "").trim();
  if (!/^file:\/\//i.test(s)) return s || null;
  s = decodeURIComponent(s.slice("file://".length).replace(/\//g, "\\"));
  // a leading backslash pair survived the swap above only for UNC; keep it
  return s || null;
}

// The same SMB share is reachable under several host aliases (\\zimaserver,
// \\192.168.4.110, \\172.22.0.1), so the collector reports one project three
// times. Two aliases pointing at the same tail are the same workspace; collapse
// them and keep whichever spelling the most recent session actually used, since
// that is the one already open in file dialogs and terminals.
function tailKey(dir) {
  const s = String(dir).replace(/\//g, "\\").replace(/\\+$/, "");
  const parts = s.split("\\");
  return parts.slice(1).join("\\").toLowerCase();
}

function collapseAliases(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = tailKey(e.directory);
    const cur = groups.get(key);
    if (!cur || e.lastUsed > cur.lastUsed) groups.set(key, e);
  }
  return [...groups.values()]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .map((e) => e.directory);
}

/**
 * Every workspace the collector has seen a session in. This doubles as the
 * dashboard's directory picker and as the name -> path index the window title
 * is resolved against.
 */
export function knownDirectories(statePath) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return [];
  }
  const newest = new Map();
  const touch = (dir, at) => {
    if (!dir) return;
    const prev = newest.get(dir.toLowerCase());
    if (!prev || (at || 0) > prev) newest.set(dir.toLowerCase(), { directory: dir, lastUsed: at || 0 });
  };
  for (const s of parsed.sessions || []) touch(s.directory, s.updatedAt);
  for (const d of parsed.details || []) touch(d.directory, d.updatedAt);
  return collapseAliases([...newest.values()]);
}

/** basename -> [full paths sharing that name], lowercased for Windows. */
function indexByName(dirs) {
  const byName = new Map();
  for (const d of dirs) {
    const key = basename(d).toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(d);
  }
  return byName;
}

// The title is "<active editor> - <folder> - VSCodium"; the folder is the segment
// before the trailing app name, and the editor segment may itself contain " - ".
function folderFromTitle(title) {
  const t = String(title || "").trim();
  if (!t) return null;
  const parts = t.split(/\s+-\s+/).filter(Boolean);
  if (parts.length >= 2 && /vscodium$/i.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return null;
  return parts[parts.length - 1].trim() || null;
}

function queryVSCodium() {
  return new Promise((done) => {
    const ps =
      "$ErrorActionPreference='SilentlyContinue';" +
      "Get-Process -Name VSCodium | Where-Object { $_.MainWindowHandle -ne 0 } |" +
      " ForEach-Object { $_.MainWindowTitle }";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (b) => { if (out.length < 8192) out += b.toString(); });
    child.on("error", () => done(null));
    child.on("close", () => done(out.trim() || null));
  });
}

/**
 * The live folder name from the VSCodium window title, or null when VSCodium is
 * closed / has no folder open. Cached briefly because it costs a process spawn.
 */
export async function liveFolderName(ttlMs = WINDOW_TTL_MS) {
  if (windowCache.value && Date.now() - windowCache.at < ttlMs) return windowCache.value;
  const title = await queryVSCodium();
  const name = folderFromTitle(title);
  windowCache = { at: Date.now(), value: name };
  return name;
}

function storedFolder(appName = "VSCodium") {
  const base = process.env.APPDATA;
  if (!base) return null;
  const p = resolve(base, appName, "User", "globalStorage", "storage.json");
  let j;
  try {
    j = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  // lastActiveWindow is written on shutdown; openedWindows is the live set
  const win = (j.windowsState || {}).lastActiveWindow || null;
  return fromFileUri(win && win.folder);
}

/**
 * Resolve the workspace directory for the chat window.
 *
 * @param {object} o
 * @param {string} [o.override]  explicit path (--workspace flag or ?dir=)
 * @param {string} o.statePath   path to state.json, for the directory index
 * @param {string} [o.appName]   editor folder under %APPDATA%, default VSCodium
 * @param {string} [o.fallback]  directory to use when nothing else resolves
 * @returns {Promise<object>}    { directory, source, name, ambiguous, candidates }
 */
export async function resolveWorkspace({
  override,
  statePath,
  appName = "VSCodium",
  fallback,
} = {}) {
  const candidates = knownDirectories(statePath);
  const byName = indexByName(candidates);

  const shape = (directory, source, extra) => ({
    directory,
    source,
    name: directory ? basename(directory) : null,
    candidates,
    ...(extra || {}),
  });

  if (override) return shape(resolve(override), "explicit");

  const live = await liveFolderName();
  if (live) {
    const hits = byName.get(live.toLowerCase()) || [];
    if (hits.length === 1) return shape(hits[0], "window");
    if (hits.length > 1) return shape(hits[0], "window", { ambiguous: hits });
  }

  const stored = storedFolder(appName);
  if (stored) {
    const hit = candidates.find((d) => d.toLowerCase() === stored.toLowerCase());
    return shape(hit || stored, "stored");
  }

  return shape(fallback ? resolve(fallback) : null, "none");
}