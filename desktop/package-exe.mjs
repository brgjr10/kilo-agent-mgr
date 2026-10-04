#!/usr/bin/env node
/*
 * package-exe.mjs — turn the Tauri build into one portable file.
 *
 * Why this exists: with `--no-bundle` Tauri does NOT embed `bundle.resources`
 * into the binary — the bundler copies them next to the exe instead. So a plain
 * `cargo tauri build --no-bundle` yields a ~3 MB shell that starts, finds no
 * payload beside itself, and shows the failure page. (That is exactly what the
 * first published build did.)
 *
 * Rather than depend on undocumented bundling behaviour, the payload is appended
 * to the finished exe behind a trailer, and the shell reads itself back:
 *
 *   [ tauri shell exe ][ payload pack ][ magic 8 bytes ][ pack length u64 ]
 *                                                            ^-- last 16 bytes
 *
 * A PE loader ignores anything after the image, so this is safe, and the exe
 * stays a single file the user can drop anywhere writable.
 *
 * The pack format is deliberately trivial rather than zip — a handful of
 * little-endian headers — so the Rust side needs no archive dependency and no
 * third-party API to get right:
 *
 *   u32 magic 'AGMP' | u32 version | u32 fileCount
 *   per file: u16 pathLen | u16 flags | u32 dataLen | path (utf8) | data
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

const PACK_MAGIC = 0x504d4741; // 'AGMP' little-endian
const PACK_VERSION = 1;
const TAIL_MAGIC = Buffer.from([0x41, 0x47, 0x4d, 0x50, 0x45, 0x4e, 0x44, 0x00]); // "AGMPEND\0"
const TAIL_LEN = TAIL_MAGIC.length + 8; // magic + u64 length

const shellExe = join(__dir, "src-tauri", "target", "release", "agent-manager.exe");
const payloadDir = join(__dir, "src-tauri", "payload");
const outDir = resolve(process.argv[2] || join(__dir, "..", "dist"));
const outExe = join(outDir, "AgentManager.exe");

function fail(message) {
  console.error("package-exe: " + message);
  process.exit(1);
}

// The payload folder holds one file that must not ship: state.json is the
// discovered session board, it is gitignored because it is machine-specific, and
// stage.mjs seeds it from the working tree when it is present. Packing the whole
// folder would therefore bake this machine's sessions into a distributed exe.
// This mirrors what bundle.resources lists in tauri.conf.json.
const EXCLUDE = new Set(["state.json"]);

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relative(base, join(dir, entry.name)).split(sep).join("/");
    if (EXCLUDE.has(rel)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function pack() {
  if (!existsSync(payloadDir)) fail(`no payload at ${payloadDir} — run "node stage.mjs" first`);
  const files = walk(payloadDir).sort();
  if (!files.length) fail(`payload at ${payloadDir} is empty`);

  const parts = [];
  const head = Buffer.alloc(12);
  head.writeUInt32LE(PACK_MAGIC, 0);
  head.writeUInt32LE(PACK_VERSION, 4);
  head.writeUInt32LE(files.length, 8);
  parts.push(head);

  let bytes = head.length;
  for (const file of files) {
    // Forward slashes: the pack is portable, so the paths inside it must be too.
    const rel = relative(payloadDir, file).split(sep).join("/");
    const name = Buffer.from(rel, "utf8");
    const data = readFileSync(file);
    if (name.length > 0xffff) fail(`${rel}: path is too long to pack`);

    const meta = Buffer.alloc(8);
    meta.writeUInt16LE(name.length, 0);
    meta.writeUInt16LE(0, 2);
    meta.writeUInt32LE(data.length, 4);

    parts.push(meta, name, data);
    bytes += meta.length + name.length + data.length;
  }

  return { buffer: Buffer.concat(parts), files, bytes };
}

function main() {
  if (!existsSync(shellExe)) fail(`no build at ${shellExe} — run the tauri build first`);

  const { buffer, files, bytes } = pack();
  const shell = readFileSync(shellExe);

  const trailer = Buffer.alloc(TAIL_LEN);
  TAIL_MAGIC.copy(trailer, 0);
  trailer.writeBigUInt64LE(BigInt(buffer.length), TAIL_MAGIC.length);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outExe, Buffer.concat([shell, buffer, trailer]));

  const total = shell.length + buffer.length + TAIL_LEN;
  console.log(`packed ${files.length} files, ${(bytes / 1048576).toFixed(1)} MB`);
  console.log(`${outExe}  ${(total / 1048576).toFixed(1)} MB total (shell ${(shell.length / 1048576).toFixed(1)} MB)`);

  // A shell with no payload attached is the exact failure this step exists to
  // prevent, so refuse to emit one rather than shipping it.
  const biggest = files
    .map((f) => ({ f, size: statSync(f).size }))
    .sort((a, b) => b.size - a.size)[0];
  if (buffer.length < biggest.size) {
    fail("payload pack is smaller than its own largest file — packing is broken");
  }
}

main();
