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
const PAYLOAD_VERSION: &str = env!("CARGO_PKG_VERSION");

const BOOT_TIMEOUT: Duration = Duration::from_secs(45);
const POLL: Duration = Duration::from_millis(150);

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
    if !packaged.exists() {
        return Err(format!(
            "the bundled payload is missing from {}",
            resource_dir.display()
        ));
    }

    // node.exe is embedded but is only useful beside the scripts, and serve.mjs
    // writes state.json and .cache/ next to itself — which the read-only
    // extraction directory should not be doing. So the payload is copied once
    // into a writable per-user folder and run from there.
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
        copy_tree(&packaged, &staging)?;
        fs::write(staging.join(".payload-version"), PAYLOAD_VERSION)
            .map_err(|e| format!("write stamp: {e}"))?;
        let _ = fs::remove_dir_all(&app_dir);
        fs::rename(&staging, &app_dir).map_err(|e| {
            format!("move staged payload into {}: {e}", app_dir.display())
        })?;
    }

    let node = node_path(&app_dir);
    if !node.exists() {
        return Err(format!("{} is missing from the payload", node.display()));
    }

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