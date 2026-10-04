# Agent Manager — build instructions

Read this before changing anything. It replaces the old flat scratch list: every item
below is scoped, anchored to the code that has to move, and has a finish line you can
actually check. Keep the file current — delete an item when it ships, add one when a
new idea appears, and record the answer to any open question in place.

---

## 1. What this is

A single-window dashboard for the Kilo CLI: every agent running right now, the subagent
task tree, session state, and a streaming chat dock. Node backend (`serve.mjs`) shells
out to the authenticated `kilo` binary and writes `state.json`; the entire UI is one
`index.html` with inline CSS and JS. `desktop/` packages the same files into a portable
`AgentManager.exe` via Tauri.

Design intent: **an ops board, not a chat app.** Dense, dark, keyboard-navigable,
scannable at a glance. It is not a marketing page and it does not get a hero section.

## 2. Ground rules

These are not style preferences. Breaking one breaks the packaged app or the user's
setup.

| Rule | Why |
| --- | --- |
| No dependencies. No bundler, no CDN, no framework. | There is no `package.json` at the repo root and the whole UI is one file, inline. A dependency cannot be shipped in the Tauri payload. |
| Backend uses Node stdlib only (`node:http`, `node:child_process`, `node:fs`). | Same reason. `stage.mjs` bundles no `node_modules`. |
| Never widen `--host` off `127.0.0.1`. | The chat dock auto-approves tools. `0.0.0.0` hands anyone on the LAN an agent with shell access in these projects (`serve.mjs:64-69`). |
| **Any new root-level `.mjs` must be added to `RUNTIME_FILES`** in `desktop/stage.mjs:37`. | That allowlist is what gets embedded. A module missing from it works from `node serve.mjs` and 404s inside `AgentManager.exe`. `assets/` is copied wholesale, so files added there need no registration. |
| Keep the GitHub dark tokens (`index.html:11-35`) as the palette. | Already the house theme. New colour means a new `--var`, not a literal hex. |
| Preserve element ids other code queries (`#liveDot`, `#meta`, `#search`, `#sessions`, …). | `render()`, `load()` and the key handler all look them up by id. |
| No model/tool output through `innerHTML`. | The dock renders output from a tool-enabled agent. Build text nodes. |
| Do not edit anything under `desktop/src-tauri/payload/`. | Generated. Rewritten by `stage.mjs` on every stage. |

## 3. Where things live

| File | Role | Touch it for |
| --- | --- | --- |
| `index.html` | Entire UI: CSS `:9-946`, markup `:949-1026`, app `:1027-1963` | anything visual or interactive |
| `serve.mjs` | Static server + all `/api/*` routes | new endpoints |
| `chat.mjs` | Private `kilo serve` on :9789, streaming client | chat transport |
| `workspace.mjs` | Resolves the folder VSCodium has open | directory picking |
| `collector.mjs` | Shells out to `kilo`, writes `state.json` | what data exists to show |
| `kilo-bin.mjs` | Finds the CLI across editor extensions, newest first | never hardcode a kilo path |
| `desktop/stage.mjs` | Builds the Tauri payload + icons | new runtime files |
| `sync.ps1` | Mirror → share | see T0 |
| `.cache/` | Derived per-session detail, keyed on `updated` | delete to force rebuild |

---

## 4. T0 — Pre-flight: `sync.ps1` no longer syncs the app

**Why this is first:** this project *runs from the share*
(`\\zimaserver\ZimaOS-HD\AppData\Projects\agent-manager`), and `sync.ps1` is how the
editable mirror reaches it. Its file list is stale — `sync.ps1:17` still lists
`dashboard.html` (renamed to `index.html` in `serve.mjs:393`) and omits `index.html`,
`chat.mjs`, `workspace.mjs` and `kilo-bin.mjs`. So the script reports `ok` while
shipping none of the UI. Every task below is unverifiable on the share until this is
fixed.

- **Do:** replace the flat `$files` array with a glob over `*.mjs` + `index.html` +
  `README.md` + `sync.ps1`, or just list them correctly. Add a final line that prints
  the newest write time of each destination file, so a stale sync is visible instead of
  silent.
- **Done when:** `.\sync.ps1` from the mirror leaves an identical `index.html` on the
  share, and running the app from the share shows the change.
- **Watch out:** the mirror is `C:\Users\brgjr\AppData\Projects\agent-manager`, and
  the two can drift. Confirm which side you are editing before you start.

---

## 5. The work

Ordered by dependency, not by original list position. T8 is last on purpose: a redesign
applied before the features exist just means doing it twice.

### T1 — Fix the header logo (no white box, bigger)

**Goal:** the wordmark sits on a light chip today, which reads as a white blob in a
dark header.

- **Anchor:** `index.html:951` (`assets/logo-wordmark.png`, `height="14"`, wrapped in
  `.logo-chip`) and the CSS at `index.html:147-163` — `.logo-chip { background: #f6f8fa }`
  is the white background, and `.header-logo { height: 14px }` is the size.
- **Do:** drop the chip background and its padding, raise the logo to ~20-22px to match
  the `h1` line box, and use the transparent variant. `assets/` already holds
  `logo-outline.png` (3.8 KB, transparent) next to `logo-wordmark.png` (32 KB, on white).
  If the wordmark's ink is dark and no transparent variant exists, recolour it once and
  commit the transparent file rather than shipping a `filter: invert()` hack.
- **Done when:** no light rectangle in the header at any zoom, logo optically the same
  height as the "Agent Manager" text, and the favicon (`index.html:8`) still reads.
- **Watch out:** `desktop/stage.mjs:227` builds the Windows icon set from
  `logo-mark.png` / `logo-wordmark.png`. If you replace either file, re-stage and check
  the icon still has contrast at 32px.

### T2 — Token total in the header

**Goal:** one number for spend, visible without scrolling or sorting the table.

- **Anchor:** `index.html:950-958` (header), helpers `num()` at `:1052` and `kpi()` at
  `:1106`. Per-session totals are `d.tokens`; the snapshot carries `data.details[]`.
- **Do:** aggregate `input + output + reasoning` (whatever the keys in `d.tokens` are —
  read `collector.mjs` before assuming) across `data.details`, render into a new
  `#tokenTotal` span next to `#meta`, and update it inside the existing header block of
  `render()` (`:1346`) so it refreshes on the normal 5s poll. Reuse `num()`. If the
  snapshot has cost data as well, show it in the tooltip, not in the header.
- **Done when:** the total updates on refresh, matches the sum of the Tokens column, and
  renders as `0` rather than blank on an empty snapshot.
- **Watch out:** the detail set is limited by `--detail` (default 8 recent roots). A
  header total over a truncated set is misleading — label it, or aggregate over
  everything `state.json` carries, not over what the table happens to show.

### T3 — Pick the directory from the header too

**Goal:** the chat folder is chosen in a dock that is hidden by default, so the app
feels like it has no idea where it is working.

- **Anchor:** `#chatDir` at `index.html:1009`, populated by `paintWorkspace()` at
  `:1687` from `chat.dirs`, which comes from `GET /api/chat/workspace` (`serve.mjs:274`)
  → `resolveWorkspace()` in `workspace.mjs`.
- **Do:** add the directory `<select>` to the header and make it the same control —
  one `change` handler, one source of truth (`chat.directory`), both selects repainted
  from `paintWorkspace()`. Do not duplicate the fetch; `loadWorkspace()` already
  returns `candidates`. Keep the dock's source badge (`explicit` / `window` / `stored` /
  `ambiguous`) visible from the header, because that badge is the only thing telling the
  user *why* a folder was chosen.
- **Done when:** changing the folder in the header updates the dock, the badge and the
  path, and starting a chat uses it. The two selects cannot disagree.
- **Watch out:** `loadWorkspace()` deliberately re-detects so **Detect** can snap back to
  what VSCodium actually has open (`:1666-1668`). Do not make a header selection sticky
  in a way that breaks that escape hatch.

### T4 — Tools and skills dropdown in the header

**Goal:** see what this machine can actually do — which agents, commands and skills are
installed — without leaving the dashboard.

- **Anchor:** new endpoint in `serve.mjs` (the `/api/chat/*` block starts at `:270`, but
  this is not chat-scoped — put it beside `/api/health` at `:376`). Header at
  `index.html:950-958`.
- **Data sources**, in resolution order, each optional and each degrading to an empty
  list rather than an error:
  | Kind | Where |
  | --- | --- |
  | agents | `<project>/.kilo/agent/*.md`, then `%USERPROFILE%\.config\kilo\agent\*.md` |
  | commands | `<project>/.kilo/command/*.md`, then the global equivalent |
  | skills | `%USERPROFILE%\.agents\skills\<name>\SKILL.md` (26 present today), then `<project>/.kilo/skills` |
  | tools | the union of `d.tools.byType` already in `state.json` (used at `index.html:1309`) with counts — this is observed reality, and needs no new CLI surface |
- **Do:** read the frontmatter `description` off each `*.md` for the dropdown's second
  line. Cache the result and stat the directories so repeat calls are cheap. Read-only:
  never write to a config dir. Guard the joins the way `serve.mjs:394-399` guards static
  paths.
- **Done when:** the dropdown populates on a machine with none of those directories
  present, still renders, and shows an empty state rather than breaking the header.
- **Watch out:** put the catalog logic in a new module (e.g. `catalog.mjs`) — and then
  **add it to `RUNTIME_FILES`** (T2 ground rule). It must not import anything outside Node
  stdlib.

### T5 — Make the live chat readable while it streams ("thinking")

**Goal:** today the dock feels frozen-then-jumpy. This is a real bug, not a polish item.

- **Root cause:** `renderChat()` (`index.html:1879-1910`) calls `body.replaceChildren()`
  and rebuilds every row from scratch, and it is invoked at the bottom of *every* SSE
  message (`:1789`). `message.part.delta` fires per token, so the whole transcript is
  torn down and reconstructed several times a second. Long conversations make it worse,
  because the cost is linear in message count.
- **Do, in this order:**
  1. Split state mutation from DOM work. The `es.onmessage` handler (`:1749`) updates
     `chat.raw` / `chat.roles` / `chat.note` only.
  2. Coalesce renders behind one `requestAnimationFrame` with a pending flag, so N deltas
     in a frame cause 1 render.
  3. Cache rows by part id (mirror the existing `chatSet` / `chat.order` bookkeeping) and
     update only the text node of the part that changed. Rebuild fully only on
     attach/reset.
  4. Then add the indicator: `session.status` `busy` already sets `chat.streaming`
     (`:1775-1778`). Surface a "thinking" state whenever the newest part is `reasoning`
     and no tool is running, with elapsed seconds since the turn started. It must
     disappear on the first text or tool part.
- **Done when:** a long streaming answer scrolls smoothly with no visible stall, the
  indicator appears during reasoning and clears reliably, and the reasoning toggle
  (`state.showReasoning`) still suppresses reasoning text.
- **Watch out:** `renderChat()` also owns the Send/Stop disabled logic and the scroll
  pinning (`:1899`). Coalescing must not let the input feel laggy — flush pending renders
  on `sendChat()` and on input.

### T6 — Format assistant messages so they are readable

> Original wording: "format compute messages to be easier to read". Read as **the
> assistant's messages**: `logRow` puts message text into a plain div via text node
> (`index.html:1196-1201`), so fenced code, lists, tables and inline code all render as one
> undifferentiated blob. Confirm this reading before starting — if it meant something
> else, the work is different.

- **Anchor:** `logRow` at `index.html:1181-1202`, shared by the chat dock
  (`:1897`) and the session-detail log (`:1246`). One renderer, two callers.
- **Do:** a small in-house renderer — no library, no CDN. In priority order: fenced code
  blocks (monospace, language chip, copy button), inline code, bullet and numbered lists,
  headings, tables, blockquotes, links as anchors with `rel="noopener noreferrer"`.
  Everything goes through text nodes; no `innerHTML` with model output.
- **Also:** tool output is truncated at a fixed 600 chars with no way to see the rest
  (`:1626`). Replace that with a "show more" toggle rather than a bigger constant.
- **Done when:** a reply containing a code fence, a bullet list and a table is readable
  in both the dock and the detail log, and a reply containing `<script>` or `<img onerror>`
  renders as literal text.
- **Watch out:** streamed text arrives as partial markdown and will flash malformed
  fences mid-render. Render the tail of a streaming part as plain text until the turn is
  idle, or the user watches half a table assemble.

### T7 — "Clear sessions" button

> **Blocked on a decision.** "Clear sessions" has two very different meanings, and one of
> them deletes the user's work. Do not build the UI until this is answered.

| Option | Meaning | Risk |
| | --- | --- |
| A — clear the view | drop `state.json`, clear `.cache/`, board goes empty until the next collect | none; fully reversible |
| B — delete sessions | remove kilo sessions from disk | destroys transcripts, including any the user wants to read later |

- **Recommendation:** ship A first, as **Reset board**, and keep the name "clear
  sessions" for B. If B is wanted, confirm the kilo subcommand exists
  (`kilo session --help`) before designing anything — the CLI surface used by this project
  is documented in README "How it works", and session deletion is not in it.
- **Do (either option):** a destructive action needs a confirm step that names the count,
  a disabled/pending state while it runs, and a result the user can read afterwards. The
  server reports what it removed; the client does not guess. Never act on the session the
  dock is currently attached to.
- **Done when:** the button cannot fire without confirmation, and the outcome (what
  changed, what failed) is visible in the banner at `index.html:960`.
- **Watch out:** `.cache/` is derived data keyed on session `updated`
  (README "How it works"). Deleting a session without its cache entry leaves a stale row
  that a later collect will not clean up.

### T8 — UI modernization and redesign

**Goal:** modernise the look without changing behaviour. This is a layout and density
pass over work T1-T7 already landed, so run it last.

- **In scope:** narrow-width header behaviour; denser session table with a sensible
  column order; hover-revealed row actions in place of always-on buttons; visible
  `:focus-visible` rings (keyboard navigation is a stated goal and currently reads as
  broken); `prefers-reduced-motion`; real empty states; consistent spacing scale;
  collapsible tool output; a breakpoint where the dock goes full-width.
- **Out of scope:** new features, new dependencies, palette changes, replacing the
  inline-CSS single-file architecture.
- **Done when:** every id in section 3 still resolves, the keyboard shortcuts in README
  ("Keyboard:") all still work, the board is still scannable at 1280px, and the app still
  runs from the packaged exe.
- **Watch out:** `render()` is one large function that rewrites most of the page. A
  redesign that starts rewriting `render()` will collide with T2, T3 and T5. Change CSS
  and markup first; only touch `render()` where a task above already did.

### T9 — Run end to end

There is no test framework in this repo and no `package.json`. Two ways to satisfy this:

| Option | Cost | Use when |
| --- | --- | --- |
| Scripted smoke pass — `smoke.mjs` hitting every endpoint and asserting on the JSON | small, no deps | now |
| Playwright / Vitest | needs deps, CI wiring, and a dev server story the Tauri build does not have | only if the suite is going to be maintained |

- **Recommend the scripted pass.** Put it somewhere it will not ship — a script outside
  `RUNTIME_FILES` is deliberate, not an oversight.
- **Must cover:** `/api/health` (distinguishes "first collect running" from "collector
  broken" — `serve.mjs:376`), `/api/state`, `/api/collect`, `/api/session/<id>` for both
  the truncated and full forms, and every `/api/chat/*` route in README "Chat endpoints"
  including the SSE stream and an abort. Then the UI pass in a browser: header controls,
  sort, search, keyboard shortcuts, session select → detail, attach-to-chat from a card,
  stream a real turn, stop it, and watch for a leaked private kilo server.
- **Done when:** it runs from a clean checkout on the share and from `AgentManager.exe`,
  and the failure modes it cannot catch — dead SSE stream, slow first collect, missing
  kilo CLI — are visibly different to the user. Those three are the ones that matter and
  no automated pass will find them.
- **Static checks available:** `node --check <file>` per `.mjs`. There is no linter and no
  typechecker configured, so do not claim otherwise in a commit message.

---

## 6. Definition of done — every task

1. `node --check` passes on every `.mjs` touched.
2. Works from `node serve.mjs` **and** from the packaged exe (re-stage, rebuild, retest
   if a runtime file changed).
3. Degrades visibly: a missing directory, a dead stream and a failed collect each look
   different. Never silently.
4. No new dependency, no new palette literal, no `innerHTML` on model output.
5. README updated if a flag, route, endpoint or file changed. The Files and Chat
   endpoints tables there are the project's index — an undocumented route is a bug.
6. This file updated: item struck through or removed, new questions answered in place.

## 7. Open questions

| # | Question | Blocks |
| --- | --- | --- |
| 1 | "Clear sessions" — reset the board, or delete kilo sessions from disk? | T7 |
| 2 | "Format compute messages" — assistant message formatting, or something else? | T6 |
| 3 | Are you editing the local mirror or the share? T0 assumes both exist and only the mirror is edited. | T0, everything |
| 4 | Is the header token total over the whole snapshot or over the `--detail`-limited set? | T2 |
| 5 | For T4, should the catalog be read-only, or should it also open the file? | T4 |

## Appendix — the original list, mapped

| Original line | Now |
| --- | --- |
| clear sessions button | T7 |
| fix main site logo (remove white background and increase size) | T1 |
| add a token total to the header | T2 |
| run e2e | T9 |
| ui modernization and redesign | T8 |
| allow the directory to be chosen from the header as well as the chat session | T3 |
| add list tools and skills drop-down menu in the header | T4 |
| "thinking" or faster updating for live chat sessions | T5 |
| format compute messages to be easier to read | T6 |
| — (found while scoping) | T0, `sync.ps1` |
