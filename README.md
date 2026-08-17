# Acciaccatura

[![CI](https://github.com/edCariadhy/acciaccatura/actions/workflows/ci.yml/badge.svg)](https://github.com/edCariadhy/acciaccatura/actions/workflows/ci.yml)

**AI-readable code annotations for VS Code.** Developers and agents attach working notes to
code — intent, constraints, gotchas, decisions — and any agent can query and act on them
through an MCP server. A note lasts as long as the work it belongs to: mark it done and it
stops reaching agents. For something meant to live forever, write a code comment instead.

> An *acciaccatura* is a grace note: a tiny note sounded just before the main one that colours
> how it's heard. A small annotation that shapes how an agent reads the code that follows.

## Why

Inline "comments for the AI" already exist, but they're locked to a single IDE or limited to
the file being edited. Acciaccatura solves it once at the protocol layer: annotations are
exposed over **MCP**, so every MCP-capable agent — Claude Code, Copilot, Cursor, and others —
reads the same intent, regardless of editor.

## How it works

1. A developer selects code in VS Code and leaves a note (**Acciaccatura: Annotate Selection**).
2. The note is stored locally as JSON in the workspace (`.acciaccatura/annotations.json`).
3. The MCP server exposes those notes so an agent can ask *"what context exists around this
   code?"* before it acts.
4. Each note is anchored to a line range with a captured snapshot, so when the code moves the
   agent is told the note may have **drifted** rather than being quietly misled.

## Install

Acciaccatura is not yet on the VS Code Marketplace. Build a `.vsix` from source and install it:

```bash
git clone https://github.com/edCariadhy/acciaccatura.git
cd acciaccatura
npm install
npm run build                              # core → mcp-server + extension, in that order
npm run package --workspace acciaccatura   # writes packages/extension/acciaccatura-<version>.vsix
code --install-extension packages/extension/acciaccatura-*.vsix
```

Reload VS Code, open a workspace, and run **Acciaccatura: Annotate Selection** (Command Palette,
or right-click in the editor) to confirm it's active. To also let agents read and write notes,
register the MCP server — see [Use the MCP server](#use-the-mcp-server) below.

Working on the extension itself instead of just using it? See [Develop](#develop) — press **F5**
to run it from source without packaging anything.

## Features

- **Capture a note** on a selection, a single line, or just the caret — no need to select text
  first. Reach it from the Command Palette or a right-click in the editor
  (**Acciaccatura: Annotate Selection**).
- **See notes without leaving the file**: a gutter icon and hover tooltip on every annotated
  line. A note that no longer matches the code gets a loud warning, not a silent guess.
- **Review from the sidebar**: notes are grouped by file, so you can read, delete, or promote an
  agent's suggestion to authoritative in one place.
- **Close the loop**: mark a note done once its work is finished, reopen it if that was wrong,
  and clear out finished notes when they're safe to delete. **How Old Are My Notes?** shows how
  long open notes have waited and finished notes have been sitting around.
- **Group notes into a named set** (a *scope*) with its own order — a PR review or an onboarding
  tour, not just notes scattered across files. Check a set's status, add a note to it, or close
  it from the sidebar.
- **Stay in sync**: the sidebar and gutter redraw when the shared store changes, including a
  note an agent just wrote over MCP while you're sitting in a different file.

## Design principles

These are strict rules, not just suggestions:

- **Helpful notes, not the final word.** AI agents must still write correct code even if a note is old, wrong, or missing. If the note and the code do not match, the code is always right.
- **Warn when things change.** It is bad if a note points to code that has changed without warning you. The system checks if the code has moved and tells you its status (`aligned`, `drifted`, or `unknown`).
- **Keep it brief.** The system only gives the AI the most important notes, not all of them. Sending too many notes uses up the AI's memory limits and slows it down.
- **One shared file.** Both humans (in the editor) and AI agents (using MCP) save notes in the same place. Every note records who wrote it, so you always know where it came from.
- **Private and local.** Notes might contain private company ideas. Nothing is sent to the internet unless you clearly choose to share it.

## Repository layout

An npm-workspaces monorepo, TypeScript on Node 20+:

| Package | License | What it is |
| --- | --- | --- |
| [`packages/core`](packages/core) | MIT | Annotation model, JSON store, anchoring/drift logic. No editor or MCP deps. |
| [`packages/mcp-server`](packages/mcp-server) | AGPL-3.0-or-later | MCP stdio server exposing the store's tools to agents. |
| [`packages/extension`](packages/extension) | MIT | The VS Code extension — the human writer. |

`core` is MIT so the MIT extension can reuse it without linking the AGPL server.

## Develop

```bash
npm install
npm run build       # core → mcp-server (tsc) + extension (esbuild)
npm run lint        # eslint (flat config)
npm run typecheck   # tsc --noEmit
npm test            # vitest: core unit + server integration + extension unit
```

The extension has real end-to-end tests that launch a VS Code instance (downloaded on first
run), kept out of the default `npm test`:

```bash
npm run test:e2e --workspace acciaccatura
```

To try the extension interactively, open the repo in VS Code and press **F5** ("Run
Extension"), then run **Acciaccatura: Annotate Selection** on a selection.

## Use the MCP server

Build, then register the server with any MCP-capable agent. With Claude Code:

```bash
claude mcp add acciaccatura --env ACCIACCATURA_WORKSPACE="$(pwd)" -- node "$(pwd)/packages/mcp-server/dist/index.js"
```

Tools exposed: `get_annotations` (bounded, ranked, drift-reported lookup), `annotate_code`
(persist a note), `remove_annotation` (drop an obsolete note). See
[packages/mcp-server](packages/mcp-server/README.md) for configuration.

## Status

Early and under active development. The store, MCP server, drift detection, and the editor
write path work and are covered by tests; anchoring is intentionally simple (line range +
snapshot) and is the main area of ongoing work.

## License

`core` and `extension` are MIT; `mcp-server` is AGPL-3.0-or-later. See each package's `LICENSE`.
