#!/usr/bin/env node
/*
 * stage.mjs — prepare everything tauri_build needs, so the Rust build never has
 * to care where its payload came from.
 *
 *   desktop/src-tauri/payload/   runtime files embedded into the exe
 *   desktop/src-tauri/icons/     icon set, resized from the dashboard's own logo
 *
 * node.exe comes from $AGENT_MANAGER_NODE or the PATH, which is what CI wants —
 * actions/setup-node has already put a matching build there — and is only
 * downloaded as a fallback for local runs.
 *
 *   node desktop/stage.mjs
 *   node desktop/stage.mjs --node C:\path\to\node.exe
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
const tauriDir = join(__dir, "src-tauri");
const payload = join(tauriDir, "payload");
const icons = join(tauriDir, "icons");

// Node LTS rather than current: the backend needs nothing newer than global fetch
// and AbortSignal.timeout, and LTS is the conservative thing to ship.
const NODE_VERSION = process.env.AGENT_MANAGER_NODE_VERSION || "v22.20.0";

// Largest png that goes into the .ico. Windows reads 32px and 256px fine.
const ICO_SIZES = [32, 128, 256];

// state.json is optional: it is gitignored, so a clean CI checkout has none. The
// app then shows an empty board until the backend's first collect finishes.
const RUNTIME_FILES = [
  "index.html",
  "serve.mjs",
  "collector.mjs",
  "chat.mjs",
  "workspace.mjs",
  "kilo-bin.mjs",
];

const OPTIONAL_RUNTIME_FILES = ["state.json"];

const PNG_ICON_SIZES = [
  [32, "32x32.png"],
  [128, "128x128.png"],
  [256, "128x128@2x.png"],
  [512, "icon.png"],
];

const log = (...a) => console.log(...a);

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function copyFile(from, to) {
  writeFileSync(to, readFileSync(from));
}

function copyTree(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, entry.name);
    const d = join(to, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else copyFile(s, d);
  }
}

// ---- payload ---------------------------------------------------------------

function stageRuntime() {
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });

  for (const f of RUNTIME_FILES) {
    const src = join(root, f);
    if (!existsSync(src)) throw new Error(`missing runtime file: ${f} (looked in ${root})`);
    copyFile(src, join(payload, f));
  }

  const seeded = [];
  for (const f of OPTIONAL_RUNTIME_FILES) {
    const src = join(root, f);
    if (existsSync(src)) {
      copyFile(src, join(payload, f));
      seeded.push(f);
    }
  }
  copyTree(join(root, "assets"), join(payload, "assets"));

  writeFileSync(
    join(payload, "README.md"),
    [
      "# Agent Manager — bundled backend",
      "",
      "Extracted from the application on launch. Rewritten on every app update, so",
      "edits here do not survive. `serve.mjs` runs from this folder and writes",
      "`state.json`, `backend.log` and `port.txt` beside itself.",
      "",
    ].join("\n"),
    "utf8"
  );

  log(`payload: ${RUNTIME_FILES.length} runtime files + assets/` +
    (seeded.length ? ` + seeded ${seeded.join(", ")}` : " (no state.json — first run collects)"));
}

// ---- node.exe --------------------------------------------------------------

function nodeOnPath() {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, ["node"], { encoding: "utf8", windowsHide: true });
  const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first && existsSync(first) ? first : null;
}

async function downloadNode() {
  const base = `https://nodejs.org/dist/${NODE_VERSION}/`;
  const meta = await (await fetch(base)).json();
  const entry = meta.find((f) => f.name === `node-${NODE_VERSION}-win-x64.zip`);
  if (!entry) throw new Error(`no win-x64 build for ${NODE_VERSION} at ${base}`);
  log(`node: downloading ${entry.name} (${(entry.size / 1048576).toFixed(1)} MB)`);

  const zip = Buffer.from(await (await fetch(base + entry.name)).arrayBuffer());
  const zipPath = join(tauriDir, ".node.zip");
  const outDir = join(tauriDir, ".node");
  writeFileSync(zipPath, zip);

  try {
    // Expand-Archive rather than a zip library: it is already present on any
    // Windows box and on the runner, so staging stays dependency-free.
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`],
      { stdio: "inherit" }
    );
    const exe = join(outDir, `node-${NODE_VERSION}-win-x64`, "node.exe");
    if (!existsSync(exe)) throw new Error(`node.exe missing after extracting to ${outDir}`);
    return exe;
  } finally {
    rmSync(zipPath, { force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function stageNode() {
  const dest = join(payload, "node.exe");
  const explicit = arg("--node", process.env.AGENT_MANAGER_NODE || "");

  let source = explicit && existsSync(explicit) ? explicit : null;
  if (!source && process.platform === "win32") source = nodeOnPath();

  if (!source) {
    if (process.platform !== "win32") {
      log("node: skipped — no node.exe to bundle on this platform");
      return;
    }
    source = await downloadNode();
  }

  // Confirm it actually runs: an arm64 or musl build would otherwise fail later,
  // inside the app, with no console to read the error from.
  const ver = spawnSync(source, ["--version"], { encoding: "utf8", windowsHide: true });
  if (ver.status !== 0) {
    throw new Error(`${source} is not a runnable Windows node: ${ver.stderr || ver.error}`);
  }
  copyFile(source, dest);
  log(`node: v${ver.stdout.trim()} from ${source}`);
}

// ---- icons -----------------------------------------------------------------

/** PNG IHDR width and height live at bytes 16..24. */
function pngSize(buf) {
  return buf.readUInt32BE(16);
}

/**
 * Pack PNGs into a Vista-style .ico: a 6-byte header, one 16-byte directory entry
 * per image, then the PNG payloads verbatim.
 */
function writeIco(pngPaths) {
  const images = pngPaths.map((p) => readFileSync(p));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;

  images.forEach((buf, i) => {
    const at = i * 16;
    const px = pngSize(buf);
    dir.writeUInt8(px >= 256 ? 0 : px, at); // 256 does not fit a size byte
    dir.writeUInt8(px >= 256 ? 0 : px, at + 1);
    dir.writeUInt8(0, at + 2); // palette size
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(buf.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += buf.length;
  });

  writeFileSync(join(icons, "icon.ico"), Buffer.concat([header, dir, ...images]));
}

/**
 * Resized with System.Drawing rather than an image library: it ships with
 * Windows, so staging needs nothing installed on a clean box or on CI.
 */
function stageIcons() {
  rmSync(icons, { recursive: true, force: true });
  mkdirSync(icons, { recursive: true });

  const source = ["logo-mark.png", "logo-wordmark.png"]
    .map((f) => join(root, "assets", f))
    .find((p) => existsSync(p));
  if (!source) throw new Error("no assets/logo-mark.png to build an icon from");

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${source}')
${PNG_ICON_SIZES.map(([px, name]) => `
$bmp = New-Object System.Drawing.Bitmap ${px}, ${px}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($src, 0, 0, ${px}, ${px})
$g.Dispose()
$bmp.Save('${join(icons, name)}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`).join("\n")}
$src.Dispose()
`;

  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "inherit",
  });

  const forIco = ICO_SIZES.map((px) => {
    const name = PNG_ICON_SIZES.find(([s]) => s === px);
    if (!name) throw new Error(`no png staged for ${px}px`);
    return join(icons, name[1]);
  });
  writeIco(forIco);

  log(`icons: ${PNG_ICON_SIZES.length} png + icon.ico (${ICO_SIZES.join("/")}) from ${basename(source)}`);
}

// ---- main ------------------------------------------------------------------

try {
  stageRuntime();
  stageIcons();
  await stageNode();
  log("stage: ok");
} catch (e) {
  console.error("stage failed: " + (e && e.message ? e.message : e));
  process.exit(1);
}