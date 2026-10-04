# Agent Manager

A reskinned dashboard for Kilo Code that shows **every agent working right now**
side by side, plus the subagent task tree and overall task completion.

Data comes from the authenticated local Kilo CLI — no server auth, no tokens in
the browser.

## Run it

```powershell
node serve.mjs --port 8080 --refresh --interval 15 --detail 8
```

Then open <http://localhost:8080>, or just double-click `AgentManager.exe`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--refresh` | off | keep re-collecting in the background; runs are chained so they never overlap |
| `--interval` | `8` | seconds between background collects (measured from the end of the previous one) |
| `--detail` | `8` | how many recent root sessions to walk into |
| `--port` | `8080` | listen port; `0` asks the OS for a free one |
| `--host` | `127.0.0.1` | interface to bind — see the warning below |
| `--workspace` | detect | pin the chat workspace instead of asking VSCodium |
| `--port-file` | none | write the bound port here once listening |

**Do not widen `--host`.** The chat window runs tools with no permission prompt,
so a listener on `0.0.0.0` hands anyone on your LAN an agent with shell access
in these projects. Loopback is the default for that reason.

Manual snapshot only, no server needed for the collector:

```powershell
node collector.mjs --detail 8
```

Keyboard: <kbd>/</kbd> search · <kbd>r</kbd> refresh · <kbd>c</kbd> chat ·
<kbd>Esc</kbd> clear selection.

## Building the portable exe

`AgentManager.exe` is a Tauri build: a native window on the system WebView, with
`serve.mjs` bundled inside it. Double-clicking it starts the backend on a free
port, waits for it, and shows the dashboard. No Node install, no console window.

It is built on GitHub Actions, because Tauri needs Rust and the MSVC toolchain
and neither belongs on a workstation:

```powershell
git tag v1.0.0
git push origin v1.0.0
```

or run the **Build Windows app** workflow by hand. The artifact is
`AgentManager-windows-x64`; unzip and run `AgentManager.exe` anywhere.

To build locally instead:

```powershell
cd desktop
node stage.mjs                                   # payload + icons
npx @tauri-apps/cli@2 build --no-bundle          # needs Rust 1.85+ and VS Build Tools
```

`--no-bundle` is what makes it portable — it emits the raw executable rather than
an MSI or NSIS installer.

| Piece | Where it comes from |
| --- | --- |
| window + process lifecycle | `desktop/src-tauri/src/lib.rs` |
| dashboard, chat, collector | bundled from this repo by `desktop/stage.mjs` |
| `node.exe` | copied from `$AGENT_MANAGER_NODE`, else PATH, else downloaded (Node LTS) |
| `kilo.exe` | **not bundled** — discovered at runtime by `kilo-bin.mjs` |

At first launch the payload is extracted from the exe into
`%LOCALAPPDATA%\AgentManager\app\`, which is also where `serve.mjs` writes
`state.json`, `backend.log` and `port-<pid>.txt`. That is also the first place to
look when the app starts but shows the failure page — `backend.log` has the URL
it bound and anything that went wrong.

Two consequences worth knowing:

- **The app needs the Kilo extension installed.** The CLI is authenticated and
  ships inside the editor, so it is discovered rather than bundled. Without it
  the dashboard cannot collect and the chat window cannot start a session.
- **First launch is slow to populate.** No snapshot is shipped, so the board is
  empty until the first collect finishes (tens of seconds). The server accepts
  requests immediately rather than blocking, so the window fills in.

## Chat window

Press <kbd>c</kbd>, or use the **chat** button on any agent card or session row.
The window streams a live agent working in whichever folder VSCodium has open.

| What | How |
| --- | --- |
| New conversation | **New** — creates a session scoped to the folder in the directory picker |
| Continue an existing agent | the **chat** button on a card or row — attaches to that session |
| Stop a running turn | **Stop** |

Tool calls are auto-approved, so the agent can read, edit and run commands in
that folder without asking. Point it somewhere throwaway if that is not what
you want.

Chats are ordinary Kilo sessions, so `collector.mjs` picks them up on the next
collect and they appear on the board like any other agent.

### How the workspace is picked

`workspace.mjs` resolves the folder in this order, and the badge in the chat
header says which one won:

| Source | Meaning |
| --- | --- |
| `explicit` | `--workspace` flag, or a folder chosen in the picker |
| `window` | the live VSCodium window title — the only live signal |
| `stored` | `globalStorage/storage.json`, which VSCodium writes on shutdown |
| `none` | nothing resolved; falls back to this project |

The window title only carries a folder *name* (`agent-manager - VSCodium`), so
it is resolved against the directories the collector has already seen. The same
share reachable under several host aliases (`\\zimaserver`, `\\192.168.4.110`)
is collapsed to one entry. When two genuinely different projects share a folder
name the badge reads `ambiguous` and its tooltip lists them.

### Chat endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/chat/workspace` | resolved folder, source, and candidate list |
| `GET /api/chat/models` | tool-capable models, split free vs metered |
| `POST /api/chat/session` | new session in a folder |
| `GET /api/chat/session/<id>` | transcript, for backfill |
| `GET /api/chat/events?session=` | SSE, one session's events |
| `POST /api/chat/send` | `{session, text}` |
| `POST /api/chat/abort` | `{session}` |

`chat.mjs` boots a private `kilo serve` on port 9789 on first use and shuts it
down with the dashboard. The extension's own kilo server is left alone: it sits
behind basic auth and is shared with the editor.

## Files

| File | Role |
| --- | --- |
| `collector.mjs` | Shells out to `kilo.exe`, writes `state.json` |
| `serve.mjs` | Static server; `/api/state`, `/api/collect`, `/api/session/<id>`, `/api/chat/*` |
| `chat.mjs` | Private `kilo serve` lifecycle + the streaming client behind the chat window |
| `workspace.mjs` | Resolves which folder VSCodium has open |
| `kilo-bin.mjs` | Finds the kilo CLI across editor extensions, newest version first |
| `index.html` | The whole UI (inline CSS + JS, no build step) |
| `desktop/` | Tauri shell that packages the above as `AgentManager.exe` |
| `state.json` | Generated snapshot — safe to delete |
| `.cache/` | Derived per-session detail cache, keyed on session `updated` |
| `sync.ps1` | Copies the editable mirror to the share this project runs from |

## How it works

Kilo's `task` tool records the child session it spawned directly in its output:

```html
<task id="ses_f05e52c46ffeavbXYfr7n3q5JF" state="completed">
```

That is the only reliable parent → subagent link, so `collector.mjs` harvests it
while exporting a session and then queues every child id it finds. That is how
the tree and the "tasks done x / y" rollup are built.

- `kilo session list --format json -a -n 500` — sessions with real timestamps.
  The human-readable table drops rows whose timestamps contain a date, so the
  JSON form is used instead.
- `kilo agent list` — agent names and modes (`primary` / `subagent`). Note this
  is **cwd-scoped**: run from this folder you get 11 agents, elsewhere 10.
- `kilo export <sessionID>` — full message/part history, which is where tool
  status, tokens, cost and touched files come from.

Exports of large sessions cost seconds, so derived detail is cached in `.cache/`
and only recomputed when a session's `updated` timestamp changes. Delete the
folder to force a clean rebuild.

## State labels

| Label | Meaning |
| --- | --- |
| `running` | newest tool call is running and the session moved in the last 2 min |
| `stalled` | a tool is still marked running but the session has not moved since |
| `active` | recent activity, no tool in flight |
| `errors` | finished with failed tool calls |
| `idle` | finished, nothing pending |

## Chat API notes

Verified against kilo 7.8.1. Two things in the API silently do not work, and
both are load-bearing:

| Endpoint | Behaviour |
| --- | --- |
| `POST /api/session/:id/prompt` | admits the prompt, then never schedules the agent loop |
| `POST /session/:id/prompt_async` | works — this is what the chat window uses |
| `POST /api/session` with `agent` | stalls the loop; omit it and let the server pick |

`GET /event` must be scoped with `?directory=`, or it only emits
`server.connected` and heartbeats instead of session events.

Tool permissions need no handling: the default agent allows `*`, so a
tool-calling prompt runs `pending → running → completed` with no permission
events raised.