#!/usr/bin/env node
/*
 * state-integrity.test.mjs — guards the one invariant that must never regress:
 * running the smoke suite must leave state.json byte-identical.
 *
 *   node --test test/
 *
 * The behavioural case spawns a server and takes ~35s, so it is opt-in:
 *
 *   SMOKE_INTEGRITY=1 node --test test/
 *
 * Both cases back up and restore state.json themselves. state.json is gitignored and
 * holds live Kilo session data; a test that damages it is worse than no test at all.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(dirname(fileURLToPath(import.meta.url)));
const statePath = join(__dir, "state.json");
const smokePath = join(__dir, "smoke.mjs");
const backupPath = join(tmpdir(), "state.json.integrity-test.bak");

const runBehavioural = process.env.SMOKE_INTEGRITY === "1";

// ── backup / restore ──────────────────────────────────────────────────────────

before(() => {
  if (!existsSync(statePath)) return;
  copyFileSync(statePath, backupPath);
});

after(() => {
  // Safety net: if the suite under test damaged state.json, put the real one back
  // before this process exits so a failing test cannot cost the owner live data.
  if (!existsSync(backupPath)) return;
  const original = readFileSync(backupPath);
  const current = existsSync(statePath) ? readFileSync(statePath) : null;
  if (current === null || !current.equals(original)) {
    writeFileSync(statePath, original);
    console.error("state-integrity: state.json was modified by the suite — restored from backup");
  }
  try { unlinkSync(backupPath); } catch { /* ignore */ }
});

// ── static guard ──────────────────────────────────────────────────────────────

test("smoke.mjs never calls require() in ESM scope", () => {
  // The original defect: smoke.mjs called require("node:fs") inside an ES module.
  // `require` is not defined there, the ReferenceError was swallowed by a catch
  // shaped for a read error, `originalState` stayed null, and cleanup() therefore
  // skipped the restore — so the suite destroyed state.json and could still exit 0.
  const source = readFileSync(smokePath, "utf8");
  const offenders = [];
  source.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (/\brequire\s*\(/.test(line)) offenders.push(`smoke.mjs:${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, [], `smoke.mjs must not use require() in ESM scope:\n${offenders.join("\n")}`);
});

test("smoke.mjs restores state.json unconditionally when a file was present", () => {
  const source = readFileSync(smokePath, "utf8");
  // The old guard was `hadState && originalState !== null`, which silently skipped the
  // restore on exactly the path where the backup had failed.
  assert.ok(
    !/hadState\s*&&\s*originalState\s*!==\s*null/.test(source),
    "cleanup must not gate the restore on originalState — that is the data-loss path",
  );
  assert.match(source, /restoreFailed/, "smoke.mjs must track a failed restore and exit non-zero on it");
});

// ── behavioural guard (opt-in) ─────────────────────────────────────────────────

test(
  "running the smoke suite leaves state.json byte-identical",
  { skip: runBehavioural ? false : "set SMOKE_INTEGRITY=1 to run (spawns a server, ~35s)" },
  async () => {
    const before = readFileSync(statePath);

    const exitCode = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [smokePath, "--no-refresh"], {
        cwd: __dir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      proc.stdout.on("data", (b) => { out += b.toString(); });
      proc.stderr.on("data", (b) => { out += b.toString(); });
      proc.on("close", (code) => resolve({ code, out }));
    });

    const after = readFileSync(statePath);
    assert.ok(
      before.equals(after),
      `state.json changed across a smoke run (exit ${exitCode.code}). ` +
      `The suite must never leave the stub snapshot behind.\n--- output ---\n${exitCode.out}`,
    );
  },
);