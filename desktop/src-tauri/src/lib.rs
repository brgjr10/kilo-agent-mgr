// Agent Manager — desktop shell.
//
// Pake's CLI can only wrap a URL or a static folder, and this app is neither:
// the dashboard reads state.json and the chat window drives a real agent, both
// of which need serve.mjs running. So this keeps Pake's shape — Tauri, a WebView
// on the system runtime, a thin window, no Electron — and adds the one thing
// Pake cannot do: start the backend, wait for it, then point the window at it.
//
// Lifecycle: stage the payload out of the embedded resources into a writable
// per-user folder, spawn `node serve.mjs --port 0`, wait for the port file it
// writes, open the window on that URL, and kill the child on exit.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// Bumped whenever the payload must be re-staged. Compared against a stamp file
/// so an app update replaces the scripts without re-copying them every launch.
///
/// This tracks the *package* version, so any change to the staged files —
/// index.html, serve.mjs, the .mjs modules — must ship alongside a version bump
/// or it will not reach anyone who already ran the previous build: their stamp
/// still matches and the stale payload is kept.
const PAYLOAD_VERSION: &str = env!("CARGO_PKG_VERSION");

const BOOT_TIMEOUT: Duration = Duration::from_secs(45);
const POLL: Duration = Duration::from_millis(150);

/// Layout of the payload appended to the exe by package-exe.mjs:
///
/// ```text
/// [ tauri shell ][ pack ][ magic 8 ][ pack length u64 ]
///                                              ^ last 16 bytes
/// ```
///
/// Spelled as bytes because the trailing NUL is invisible in a diff, and the
/// two halves have to agree on it exactly.
const TAIL_MAGIC: [u8; 8] = [0x41, 0x47, 0x4d, 0x50, 0x45, 0x4e, 0x44, 0x00];
const TAIL_SIZE: u64 = 16;

const PACK_MAGIC: u32 = 0x504d_4741; // 'AGMP', little-endian
const PACK_VERSION: u32 = 1;

/// The backend belongs to the one running app instance, so a static is simpler
/// than threading an `Arc` through the Tauri builder closures. `Child: Send`,
/// which is what makes this a valid `static`.
static BACKEND: Mutex<Option<Child>> = Mutex::new(None);

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            match boot(&handle) {
                Ok(url) => {
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                        .title("Agent Manager")
                        .inner_size(1500.0, 940.0)
                        .min_inner_size(900.0, 560.0)
                        .resizable(true)
                        .build()?;
                }
                Err(why) => {
                    // A blank window or a panic tells the user nothing, so the
                    // failure page is given the reason up front. It is injected
                    // rather than passed in the URL because a file:// page has
                    // no query string to carry it.
                    let reason = serde_json::to_string(&why)
                        .unwrap_or_else(|_| "\"unknown error\"".to_string());
                    let script = format!("window.__AGENT_MANAGER_ERROR__ = {reason};");
                    WebviewWindowBuilder::new(
                        &handle,
                        "main",
                        WebviewUrl::App(PathBuf::from("error.html")),
                    )
                    .title("Agent Manager")
                    .inner_size(940.0, 640.0)
                    .initialization_script(script)
                    .build()?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Agent Manager");

    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            stop_backend();
        }
    });
}

/// Kill the backend if it is still running.
///
/// Letting the `Child` drop would not do this: Rust reaps a child that has
/// exited but never terminates one that has not. Without this, quitting the app
/// would leave a node process holding its port and the next launch would attach
/// to an invisible server.
fn stop_backend() {
    if let Ok(mut slot) = BACKEND.lock() {
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *slot = None;
    }
}

/// Stage the payload, start the server, and return the URL it serves on.
fn boot(handle: &tauri::AppHandle) -> Result<Url, String> {
    let resource_dir = handle
        .path()
        .resource_dir()
        .map_err(|e| format!("no resource directory: {e}"))?;
    let packaged = resource_dir.join("agent-manager");

    // node.exe travels with the payload but is only useful beside the scripts,
    // and serve.mjs writes state.json and .cache/ next to itself — which the
    // folder the exe happens to sit in should not be doing. So the payload is
    // materialised once into a writable per-user folder and run from there.
    let base = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("no per-user data directory: {e}"))?;
    fs::create_dir_all(&base).map_err(|e| format!("create {}: {e}", base.display()))?;
    let app_dir = base.join("app");

    let stamp = app_dir.join(".payload-version");
    let staged = fs::read_to_string(&stamp)
        .map(|s| s.trim() == PAYLOAD_VERSION)
        .unwrap_or(false);

    if !staged {
        // Staged beside the target and moved into place, so an interrupted copy
        // cannot leave a half-written app directory that looks valid next launch.
        let staging = base.join("app.staging");
        let _ = fs::remove_dir_all(&staging);
        if packaged.is_dir() {
            copy_tree(&packaged, &staging)?;
        } else {
            // The published single file carries its payload appended to its own
            // binary, which `--no-bundle` never embeds for us.
            unpack_appended(&staging)?;
        }
        fs::write(staging.join(".payload-version"), PAYLOAD_VERSION)
            .map_err(|e| format!("write stamp: {e}"))?;
        let _ = fs::remove_dir_all(&app_dir);
        fs::rename(&staging, &app_dir).map_err(|e| {
            format!("move staged payload into {}: {e}", app_dir.display())
        })?;
    }

    let node = match find_node(&app_dir) {
        Some(p) => p,
        None => {
            return Err(format!(
                "no node runtime: {} is not in the payload and no node.exe is on PATH",
                node_path(&app_dir).display()
            ))
        }
    };

    // Per-process, so two windows started at once cannot delete each other's
    // port file and then both sit waiting for a port that is never rewritten.
    // The resolved URL is always in backend.log.
    let port_file = app_dir.join(format!("port-{}.txt", std::process::id()));
    let _ = fs::remove_file(&port_file);

    // The backend's stdout/stderr are the only diagnostic available once it is
    // running detached, and the failure page quotes them.
    let log_path = app_dir.join("backend.log");
    let log = fs::File::create(&log_path).map_err(|e| format!("create log: {e}"))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("clone log handle: {e}"))?;

    let mut command = Command::new(&node);
    command
        .current_dir(&app_dir)
        .arg("serve.mjs")
        .arg("--port")
        .arg("0")
        .arg("--port-file")
        .arg(&port_file)
        .arg("--refresh")
        .arg("--interval")
        .arg("15")
        .arg("--detail")
        .arg("8")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW: no console flash

    // mutable because the failure path below kills and reaps it
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", node.display()))?;

    let url = match wait_for_port(&port_file, &log_path) {
        Ok(url) => url,
        Err(why) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(why);
        }
    };

    // On a poisoned lock the child would otherwise be dropped un-killed, leaving a
    // node process holding a port that nothing will ever reap.
    if let Err(e) = BACKEND.lock() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("backend state was poisoned: {e}"));
    }
    if let Ok(mut slot) = BACKEND.lock() {
        *slot = Some(child);
    }

    Ok(url)
}

/// Poll the port file instead of sleeping a fixed amount. serve.mjs writes it the
/// instant the socket binds, so this returns as fast as the server actually
/// starts rather than always paying the full timeout.
fn wait_for_port(port_file: &Path, log_path: &Path) -> Result<Url, String> {
    let deadline = Instant::now() + BOOT_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(port_file) {
            let port = text.trim();
            // Digits only: a truncated or half-written file must not become a URL.
            if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
                let raw = format!("http://127.0.0.1:{port}");
                // WebviewUrl::External takes a parsed Url, not a string.
                return raw
                    .parse::<Url>()
                    .map_err(|e| format!("{raw} is not a usable url: {e}"));
            }
        }
        std::thread::sleep(POLL);
    }

    let log = fs::read_to_string(log_path).unwrap_or_default();
    let tail: Vec<&str> = log.lines().rev().take(12).collect();
    Err(format!(
        "the backend did not report a port within {}s.\n\n{}",
        BOOT_TIMEOUT.as_secs(),
        if tail.is_empty() {
            "(backend.log was empty)".to_string()
        } else {
            tail.join("\n")
        }
    ))
}

fn node_path(app_dir: &Path) -> PathBuf {
    app_dir.join(if cfg!(windows) { "node.exe" } else { "node" })
}

/// Prefer the bundled runtime, but fall back to one on PATH.
///
/// The bundled copy is the point of the exercise — a machine with no Node should
/// still be able to run this. The fallback is kept for the case where staging
/// produced a folder without a usable `node.exe` (an antivirus stripping it, a
/// pack built from an incomplete payload); a missing runtime should be reported
/// against both places rather than only the first one tried.
fn find_node(app_dir: &Path) -> Option<PathBuf> {
    let bundled = node_path(app_dir);
    if bundled.exists() {
        return Some(bundled);
    }

    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Recursive copy. Tauri preserves the executable bit on extraction, but nothing
/// here depends on it: on Windows the payload is only ever run through the
/// explicit path built above.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("create {}: {e}", to.display()))?;
    let entries = fs::read_dir(from).map_err(|e| format!("read {}: {e}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let target = to.join(entry.file_name());
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)
                .map_err(|e| format!("copy {}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// Expand the payload appended to this exe into `dest`.
///
/// The pack is a flat sequence of little-endian headers rather than a zip, so
/// unpacking needs no archive dependency on the one code path that has to work
/// before the app can start:
///
/// ```text
/// u32 magic 'AGMP' | u32 version | u32 fileCount
/// per file: u16 pathLen | u16 flags | u32 dataLen | path (utf8) | data
/// ```
fn unpack_appended(dest: &Path) -> Result<(), String> {
    let pack = read_appended_pack()?;
    fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;

    let mut at = 0usize;
    let magic = u32::from_le_bytes(take(&pack, &mut at, 4)?.try_into().unwrap());
    if magic != PACK_MAGIC {
        return Err("the embedded payload is corrupt (bad header)".to_string());
    }
    let version = u32::from_le_bytes(take(&pack, &mut at, 4)?.try_into().unwrap());
    if version != PACK_VERSION {
        return Err(format!(
            "the embedded payload is format v{version}, this build reads v{PACK_VERSION}"
        ));
    }
    let count = u32::from_le_bytes(take(&pack, &mut at, 4)?.try_into().unwrap());

    for _ in 0..count {
        let path_len = u16::from_le_bytes(take(&pack, &mut at, 2)?.try_into().unwrap()) as usize;
        take(&pack, &mut at, 2)?; // flags, reserved
        let data_len = u32::from_le_bytes(take(&pack, &mut at, 4)?.try_into().unwrap()) as usize;

        let raw = take(&pack, &mut at, path_len)?;
        let rel = std::str::from_utf8(raw).map_err(|e| format!("payload path: {e}"))?;

        // This unpacks a binary it reads off itself, so a malformed pack must
        // not be able to name a target outside the destination folder.
        if rel.starts_with('/') || rel.contains("..") || rel.contains('\\') || rel.contains(':') {
            return Err(format!("payload path {rel:?} is not a safe relative path"));
        }

        let target = dest.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let data = take(&pack, &mut at, data_len)?;
        fs::write(&target, data).map_err(|e| format!("write {}: {e}", target.display()))?;
    }

    Ok(())
}

/// Slice `len` bytes at `at`, advancing it, or fail rather than read past the end.
fn take<'a>(buf: &'a [u8], at: &mut usize, len: usize) -> Result<&'a [u8], String> {
    let end = at.checked_add(len).ok_or("payload length overflow")?;
    let slice = buf.get(*at..end).ok_or("the embedded payload ends early")?;
    *at = end;
    Ok(slice)
}

/// Read back the pack appended to the running exe.
fn read_appended_pack() -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};

    let exe = std::env::current_exe().map_err(|e| format!("locate this exe: {e}"))?;
    let mut file = fs::File::open(&exe).map_err(|e| format!("open {}: {e}", exe.display()))?;
    let size = file
        .metadata()
        .map_err(|e| format!("size {}: {e}", exe.display()))?
        .len();

    if size <= TAIL_SIZE {
        return Err("this exe is too small to carry a payload".to_string());
    }
    file.seek(SeekFrom::End(-(TAIL_SIZE as i64)))
        .map_err(|e| format!("seek in {}: {e}", exe.display()))?;
    let mut tail = [0u8; 16];
    file.read_exact(&mut tail).map_err(|e| format!("read trailer: {e}"))?;

    if tail[..8] != TAIL_MAGIC {
        return Err(format!(
            "this exe carries no embedded payload, and no payload folder was found beside it \
             in {}.\n\nThis is most likely the raw shell from `tauri build --no-bundle`, which \
             does not embed the scripts. Use the packaged AgentManager.exe instead.",
            exe.parent().unwrap_or(&exe).display()
        ));
    }

    let len = u64::from_le_bytes(tail[8..16].try_into().unwrap());
    let start = size
        .checked_sub(TAIL_SIZE + len)
        .ok_or("the payload length in the trailer is larger than the exe")?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek to payload: {e}"))?;

    let mut pack = vec![0u8; len as usize];
    file.read_exact(&mut pack)
        .map_err(|e| format!("read payload: {e}"))?;
    Ok(pack)
}