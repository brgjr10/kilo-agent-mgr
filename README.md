# Agent Manager

A reskinned dashboard for Kilo Code that shows **every agent working right now**
side by side, plus the subagent task tree and overall task completion.

Data comes from the authenticated local Kilo CLI — no server auth, no tokens in
the browser.

## Run it

```powershell
node serve.mjs --port 8080 --refresh --interval 15 --detail 8
```

Then open <http://localhost:8080>.

Two flags matter:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--refresh` | off | keep re-collecting in the background; runs are chained so they never overlap |
| `--interval` | `8` | seconds between background collects (measured from the end of the previous one) |
| `--detail` | `8` | how many recent root sessions to walk into |
| `--port` | `8080` | listen port |

Manual snapshot only, no server needed for the collector:

```powershell
node collector.mjs --detail 8
```

Keyboard: <kbd>/</kbd> search · <kbd>r</kbd> refresh · <kbd>Esc</kbd> clear selection.

## Files

| File | Role |
| --- | --- |
| `collector.mjs` | Shells out to `kilo.exe`, writes `state.json` |
| `serve.mjs` | Static server; also exposes `/api/state` and `/api/collect` |
| `dashboard.html` | The whole UI (inline CSS + JS, no build step) |
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