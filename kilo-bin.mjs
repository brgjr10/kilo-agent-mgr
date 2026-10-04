#!/usr/bin/env node
/*
 * kilo-bin.mjs — locate the kilo CLI.
 *
 * The old paths were pinned to kilocode.kilo-code-7.8.1-win32-x64, so the
 * dashboard broke the moment the extension updated or moved between VSCodium
 * and VS Code. Resolution order:
 *
 *   1. $KILO_BIN                      explicit override, always wins
 *   2. <extensions>/kilocode.kilo-code-<version>-<arch>/bin/kilo(.exe)
 *      scanned under every known extension root, highest version first
 *   3. kilo(.exe) on PATH
 *
 * Extensions live in a versioned folder per platform suffix, and several can be
 * installed at once, so this picks the newest rather than the first match.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXE = process.platform === "win32" ? "kilo.exe" : "kilo";
const PREFIX = "kilocode.kilo-code-";

// "7.8.1" -> [7, 8, 1]; a non-numeric segment sorts as 0 so a beta or rc build
// never outranks a real release.
function versionOf(folder) {
  const m = folder.slice(PREFIX.length).match(/^(\d+(?:\.\d+)*)/);
  return (m ? m[1] : "").split(".").map((n) => parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const x = versionOf(a);
  const y = versionOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] || 0) - (x[i] || 0); // descending: newest first
    if (d) return d;
  }
  return a.localeCompare(b);
}

function extensionRoots() {
  const home = homedir();
  return [
    join(home, ".vscode-oss", "extensions"),
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".cursor", "extensions"),
    join(home, ".windsurf", "extensions"),
  ];
}

function fromExtensions() {
  for (const root of extensionRoots()) {
    let folders;
    try {
      folders = readdirSync(root).filter((f) => f.startsWith(PREFIX));
    } catch {
      continue; // not installed here
    }
    folders.sort(compareVersions);
    for (const f of folders) {
      const bin = join(root, f, "bin", EXE);
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

function fromPath() {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [EXE], { encoding: "utf8", windowsHide: true });
  const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first && existsSync(first) ? first : null;
}

let cached = null;

/** Absolute path to the kilo CLI, or null when it cannot be found. */
export function kiloBin() {
  if (cached) return cached;
  const override = process.env.KILO_BIN;
  if (override && existsSync(override)) {
    cached = override;
    return cached;
  }
  cached = fromExtensions() || fromPath() || null;
  return cached;
}

/**
 * kiloBin() but never null — callers that shell out need a path to put in an
 * error message, and a wrong-but-plausible path beats a bare "not found".
 */
export function kiloBinOrFallback() {
  return kiloBin() || (process.platform === "win32" ? "kilo.exe" : "kilo");
}