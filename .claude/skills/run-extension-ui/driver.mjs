// CDP driver for a real VS Code Extension Development Host running this repo's
// `acciaccatura` extension. No playwright dependency — Node 22's built-in
// fetch + WebSocket talk raw CDP directly. macOS only (uses the darwin build
// cached by @vscode/test-electron); adapt CODE_BIN + add xvfb-run for Linux.
//
// Usage: node .claude/skills/run-extension-ui/driver.mjs <command> [args...]
//   launch                 — spawn VS Code (detached), wait for the workbench CDP target
//   screenshot [file]      — PNG of the workbench window (default: timestamped, in this dir)
//   eval <js>              — Runtime.evaluate in the workbench renderer, print JSON
//   click <css-sel>        — DOM .click() on the first match (bypasses coordinate math)
//   key <key> [mods]       — dispatch a key (e.g. "Enter", "Escape", "p"); mods: "cmd,shift"
//   type <text>            — type text char by char into the focused input/editor
//   quit                   — close VS Code
//
// Each invocation is a separate `node` process (agent-friendly, no REPL to keep
// alive) — state (pid, CDP target ws url) persists to .driver-state.json next to
// this script between calls.
//
// Requires `packages/extension/.vscode-test/` to already hold a downloaded VS
// Code build — run `npm run test:e2e --workspace acciaccatura` once to prime it
// (downloads on first run), and `npm run build --workspace @acciaccatura/core &&
// npm run build --workspace acciaccatura` so `packages/extension/out/` exists.

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, "../../..");
const STATE_FILE = path.join(HERE, ".driver-state.json");
const PORT = 9333;

const EXT_DEV_PATH = path.join(REPO, "packages/extension");
const EXTENSIONS_DIR = path.join(REPO, "packages/extension/.vscode-test/extensions");
const WORKSPACE = path.join(HERE, "ui-test-workspace");
const USER_DATA_DIR = "/tmp/acc-manual-e2e"; // short — long paths blow macOS's ~103-char unix socket limit
const PORTABLE_DIR = "/tmp/acc-portable"; // must also be short; see launch() for why it exists

function findCodeBin() {
  const cacheDir = path.join(REPO, "packages/extension/.vscode-test");
  const versionDir = readdirSync(cacheDir).find((d) => d.startsWith("vscode-"));
  if (!versionDir) {
    throw new Error(
      `no VS Code build found under ${cacheDir} — run 'npm run test:e2e --workspace acciaccatura' once to download it`,
    );
  }
  return path.join(cacheDir, versionDir, "Visual Studio Code.app/Contents/MacOS/Code");
}

function loadState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function findWorkbenchTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  return targets.find(
    (t) => t.type === "page" && /workbench\.html/.test(t.url) && !/webview/.test(t.url),
  );
}

async function cmdLaunch() {
  mkdirSync(WORKSPACE, { recursive: true });

  // VS Code only honors --remote-debugging-port through an allow-listed
  // argv.json (see out/main.js r7()/s7() in the app bundle) — a bare CLI flag
  // is silently dropped. Without VSCODE_PORTABLE that file is ~/.vscode/argv.json,
  // shared with the user's real VS Code install, so point VSCODE_PORTABLE at a
  // scratch dir and write our own copy there instead. Portable mode then also
  // forces user-data under <PORTABLE_DIR>/user-data, which is why that dir has
  // to be short too (same unix-socket length limit as --user-data-dir).
  mkdirSync(PORTABLE_DIR, { recursive: true });
  writeFileSync(
    path.join(PORTABLE_DIR, "argv.json"),
    JSON.stringify({ "remote-debugging-port": String(PORT) }),
  );

  const args = [
    `--extensionDevelopmentPath=${EXT_DEV_PATH}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    `--extensions-dir=${EXTENSIONS_DIR}`,
    "--disable-workspace-trust",
    "--skip-release-notes",
    "--skip-welcome",
    "--new-window",
    WORKSPACE,
  ];
  const child = spawn(findCodeBin(), args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, VSCODE_PORTABLE: PORTABLE_DIR },
  });
  child.unref();
  console.log("spawned pid", child.pid, "waiting for CDP target...");

  const deadline = Date.now() + 30_000;
  let target = null;
  while (Date.now() < deadline) {
    try {
      target = await findWorkbenchTarget();
      if (target) break;
    } catch {
      // CDP port not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!target) throw new Error("timed out waiting for workbench CDP target");

  saveState({ pid: child.pid, wsUrl: target.webSocketDebuggerUrl });
  console.log("launched. target:", target.title, target.url);
}

let _wsIdSeq = 1;
function sendCdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _wsIdSeq++;
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener("message", onMessage);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function withWs(fn) {
  const state = loadState();
  if (!state.wsUrl) throw new Error("not launched — run `launch` first");
  const ws = new WebSocket(state.wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  try {
    return await fn(ws);
  } finally {
    ws.close();
  }
}

async function cmdScreenshot(file) {
  const out = file ? path.resolve(file) : path.join(HERE, `screenshot-${Date.now()}.png`);
  const result = await withWs((ws) => sendCdp(ws, "Page.captureScreenshot", { format: "png" }));
  writeFileSync(out, Buffer.from(result.data, "base64"));
  console.log("screenshot:", out);
}

async function cmdEval(expr) {
  const result = await withWs((ws) =>
    sendCdp(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
  );
  if (result.exceptionDetails) {
    console.log(
      "ERROR:",
      result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails),
    );
  } else {
    console.log(JSON.stringify(result.result.value));
  }
}

async function cmdClick(selector) {
  await cmdEval(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'NOT_FOUND'; el.click(); return 'OK'; })()`,
  );
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  Up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  F10: { key: "F10", code: "F10", windowsVirtualKeyCode: 121 },
  ContextMenu: { key: "ContextMenu", code: "ContextMenu", windowsVirtualKeyCode: 93 },
};

function resolveKey(keyName) {
  if (KEYS[keyName]) return KEYS[keyName];
  if (/^[a-zA-Z]$/.test(keyName)) {
    const upper = keyName.toUpperCase();
    return { key: keyName, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  return null;
}

async function cmdKey(keyName, modsArg) {
  const k = resolveKey(keyName);
  if (!k) throw new Error(`unknown key ${keyName} — add it to KEYS or use a single letter`);
  const mods = (modsArg || "").split(",").filter(Boolean);
  let modifiers = 0;
  if (mods.includes("alt")) modifiers |= 1;
  if (mods.includes("ctrl")) modifiers |= 2;
  if (mods.includes("meta") || mods.includes("cmd")) modifiers |= 4;
  if (mods.includes("shift")) modifiers |= 8;

  await withWs(async (ws) => {
    for (const type of ["keyDown", "keyUp"]) {
      await sendCdp(ws, "Input.dispatchKeyEvent", { type, modifiers, ...k });
    }
  });
  console.log("key:", keyName, mods.join("+") || "(none)");
}

async function cmdType(text) {
  // Only the "char" event should carry `text` — putting `text` on keyDown too
  // double-inserts each character in Electron's Chromium.
  await withWs(async (ws) => {
    for (const ch of text) {
      await sendCdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: ch });
      await sendCdp(ws, "Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch, key: ch });
      await sendCdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
  });
  console.log("typed:", JSON.stringify(text));
}

async function cmdQuit() {
  const state = loadState();
  if (state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already dead
    }
  }
  saveState({});
  console.log("quit.");
}

const [, , cmd, ...rest] = process.argv;
const arg = rest.join(" ");

const COMMANDS = {
  launch: cmdLaunch,
  screenshot: cmdScreenshot,
  eval: cmdEval,
  click: () => cmdClick(rest[0]),
  key: () => cmdKey(rest[0], rest[1]),
  type: cmdType,
  quit: cmdQuit,
};

const fn = COMMANDS[cmd];
if (!fn) {
  console.log("usage: node driver.mjs <launch|screenshot|eval|click|key|type|quit> [args]");
  process.exit(1);
}
fn(arg).catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
