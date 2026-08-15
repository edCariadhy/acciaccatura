# Acciaccatura

[![CI](https://github.com/edCariadhy/acciaccatura/actions/workflows/ci.yml/badge.svg)](https://github.com/edCariadhy/acciaccatura/actions/workflows/ci.yml)

**AI-readable code annotations for VS Code.** Developers and agents attach durable notes to
code — intent, constraints, gotchas, decisions — and any agent can query and act on them
through an MCP server.

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

## Design principles

These are hard constraints, not preferences:

- **Advisory, never authority.** Agents must produce correct work when a note is stale, wrong,
  or absent. The code always wins on conflict.
- **Degrade loudly.** A note silently pointing at changed code is worse than no note. Drift is
  detected and surfaced (`aligned` / `drifted` / `unknown`).
- **Bounded context.** Queries return the few most relevant notes (ranked, capped), never a
  full dump — every returned note costs an agent's context window on every later turn.
- **Two writers, one store.** Humans (editor) and agents (MCP) write to the same store;
  provenance and trust are on every record.
- **Local by default.** Notes may carry proprietary reasoning; nothing leaves the machine
  without an explicit user action.

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
