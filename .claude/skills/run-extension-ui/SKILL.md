---
name: run-extension-ui
description: Launch and drive a real, visible VS Code Extension Development Host running the `acciaccatura` extension — take screenshots, click, type, and run commands, the same way you'd drive a web UI with a browser tool. Use when asked to run the extension, see the annotation UI, or verify a UI change actually works (not just that tests pass).
---

The extension's `npm test` suite (vitest) and `test:e2e` suite (mocha inside a
real VS Code, headless-shaped) both check *behavior*, not what a human sees.
For "does the tree view render", "does the gutter decoration show up", "does
this new command actually appear in the palette" — launch the real UI and
look at it, via the CDP driver at `driver.mjs` in this folder.

No `playwright` dependency: Node 22's built-in `fetch` + `WebSocket` speak raw
Chrome DevTools Protocol directly to the Electron Extension Development Host.
**macOS only** as written (drives the darwin build `@vscode/test-electron`
already caches); porting to Linux means swapping `findCodeBin()`'s app-bundle
path and wrapping launches in `xvfb-run`.

## Prerequisites

```bash
npm run build --workspace @acciaccatura/core
npm run build --workspace acciaccatura
npm run test:e2e --workspace acciaccatura   # first run only: downloads VS Code into packages/extension/.vscode-test/
```

The last command can be `Ctrl-C`'d once the mocha run starts — you only need
the download, not the test results.

## Run

```bash
cd /path/to/acciaccatura   # repo root
node .claude/skills/run-extension-ui/driver.mjs launch
node .claude/skills/run-extension-ui/driver.mjs screenshot
```

Each call is a separate `node` process — no REPL to keep alive. State (the
spawned PID, the CDP target's WebSocket URL) persists to
`.driver-state.json` next to the driver between calls.

The launched window opens a fixture workspace at `ui-test-workspace/` (one
file, `sample.ts`) with a **clean, isolated profile** — its own
`--user-data-dir`, its own `--extensions-dir`
(`packages/extension/.vscode-test/extensions`), so none of your real VS Code
extensions or settings leak in and nothing you do in it touches your real
`~/.vscode`.

### Commands

| command | what it does |
|---|---|
| `launch` | spawn VS Code, wait for the workbench CDP target (~30s timeout) |
| `screenshot [file]` | PNG of the workbench window (default: timestamped, in this dir) |
| `click <css-sel>` | DOM `.click()` on the first match — bypasses coordinate math entirely |
| `key <name> [mods]` | dispatch a key; `mods` is comma-separated: `cmd,shift,alt,ctrl` |
| `type <text>` | type text into whatever's focused (input box, editor) |
| `eval <js>` | `Runtime.evaluate` in the workbench renderer, prints the JSON result |
| `quit` | SIGTERM the spawned process |

`key` recognizes `Enter Escape Tab Backspace Home End Up Down Left Right`
plus any single letter (`p`, `a`, …) by name. Add more to the `KEYS` table in
`driver.mjs` as needed — CDP virtual key codes are looked up in the Chromium
`ui/events/keycodes/keyboard_codes.h` table if you need one that isn't there.

## Example: drive the whole annotate flow

```bash
D="node .claude/skills/run-extension-ui/driver.mjs"
$D launch
$D key p cmd                      # Quick Open
$D type sample.ts
$D key Enter                      # open the file
$D key Home
$D key Down shift                 # select line 1
$D key p "cmd,shift"              # Command Palette
$D type "Annotate Selection"
$D key Enter                      # runs acciaccatura.annotateSelection
$D type "why this line matters"
$D key Enter                      # confirms the input box
$D screenshot after-annotate.png
$D quit
```

This is exactly how the extension's own manual verification was done: file
opened, selection made, command run through the real Command Palette, real
`showInputBox` typed into, then the tree view and gutter decoration checked
by eye in the screenshot — not asserted in code.

## Gotchas

- **`--remote-debugging-port` on the CLI is silently ignored.** VS Code only
  honors it through an allow-listed `argv.json` (see `r7()`/`s7()` in the app
  bundle's `out/main.js`) — a bare launch flag never reaches Chromium. Without
  `VSCODE_PORTABLE` set, that file is `~/.vscode/argv.json`, which is the
  **same file your real, everyday VS Code reads** — writing to it would leak a
  permanent debug flag into your primary install. The driver sets
  `VSCODE_PORTABLE=/tmp/acc-portable` and writes `argv.json` there instead, so
  the real install is never touched.
- **Portable-mode paths must stay short.** Once `VSCODE_PORTABLE` is set, VS
  Code forces `user-data` under `<VSCODE_PORTABLE>/user-data`, and that path
  becomes a unix socket path (`<...>/1.13-main.sock`) — macOS caps those at
  ~103 chars. A portable dir under a deep scratch/tmp path fails with `listen
  EINVAL`. Keep `PORTABLE_DIR` and `USER_DATA_DIR` short (`/tmp/...`), same
  reasoning as the `--user-data-dir` note already in
  `packages/extension/.vscode-test.mjs`.
- **CDP `type` events double every character if `text` is set on `keyDown`.**
  Only the `char` event should carry `text`/`unmodifiedText`; putting it on
  `keyDown` too makes Electron's Chromium insert each character twice (`"ab"`
  → `"aabb"`). The driver's `cmdType` only sets `text` on the `char` event.
- **The Electron binary is `Code`, not `Electron`.** Inside
  `Visual Studio Code.app/Contents/MacOS/`, the executable is named `Code`.
- **Pass `--extensions-dir` explicitly.** Without it, the dev host falls back
  to your real `~/.vscode/extensions` and every extension you have installed
  loads alongside `acciaccatura`, cluttering screenshots and slowing startup.
  Point it at `packages/extension/.vscode-test/extensions` (already isolated,
  already used by `test:e2e`).

## Troubleshooting

- **`no VS Code build found`:** run `npm run test:e2e --workspace
  acciaccatura` once (Ctrl-C after it starts) to trigger the download.
- **`launch` times out waiting for the CDP target:** check
  `/tmp/acc-portable/user-data/logs/<timestamp>/main.log` for a startup
  error — most likely a stale lock from a previous instance that didn't exit
  cleanly (`pkill -f "packages/extension/.vscode-test/vscode-darwin"` and
  retry) or a socket-path-length `EINVAL` (see Gotchas above).
- **Extension doesn't appear to activate:** rebuild it first —
  `--extensionDevelopmentPath` loads `packages/extension/out/extension.js`
  directly, so a stale or missing build means the dev host runs old (or no)
  code. `npm run build --workspace acciaccatura`.
