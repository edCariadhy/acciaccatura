# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Acciaccatura** — AI-readable code annotations for VS Code. Developers and agents
attach durable notes to code (intent, constraints, gotchas, decisions); agents query
and act on those notes through an MCP server. The differentiator is IDE-agnostic intent
delivered at the protocol layer: solve it once over MCP so every agent benefits, not just
users of one IDE.

Stack: TypeScript on Node 20+, an npm-workspaces monorepo. The MCP server uses
`@modelcontextprotocol/sdk` (installed: 1.30.0) + `zod`; tests use `vitest`. The extension
uses the VS Code extension API (`@types/vscode`).

## Layout

- `packages/mcp-server` — the core, **licensed AGPL-3.0-or-later**. Annotation model,
  local JSON store, MCP stdio server. Build this first; the extension depends on its model.
- `packages/extension` — the VS Code extension (human writer), **licensed MIT**. Currently
  a lazy-activated command skeleton; annotation capture is a `TODO(first-slice)`.

The two licenses differ by design: the extension is MIT, the server is AGPL-3.0-or-later.
Keep new server code out of the extension package and vice versa.

## Commands (verified working)

Run from the repo root. Workspace scripts fan out via `--workspaces --if-present`.

```bash
npm install                 # install all workspaces
npm run build               # tsc build both packages
npm test                    # vitest (mcp-server); extension has no tests yet
npm run typecheck           # tsc --noEmit across workspaces
```

Scoped to one package / a single test:

```bash
npm run build --workspace @acciaccatura/mcp-server
npm test --workspace @acciaccatura/mcp-server -- test/anchor.test.ts   # one file
npm test --workspace @acciaccatura/mcp-server -- -t "drifted"          # one test by name
```

Smoke-test the server over stdio (initialize + list tools):

```bash
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node packages/mcp-server/dist/index.js
```

Server config via env: `ACCIACCATURA_WORKSPACE` (anchor-resolution root, default cwd) and
`ACCIACCATURA_STORE` (default `<workspace>/.acciaccatura/annotations.json`).

Note: `npm audit` reports dev-only advisories in vitest's transitive `esbuild`/`vite`
(the esbuild dev-server issue) — not in shipped code. The fix is a breaking vitest v4 bump;
left for a deliberate upgrade, not an incidental one.

There is no linter configured yet (only `tsc` strict typecheck). Add one deliberately if
wanted; don't invoke `eslint`/`prettier` scripts that don't exist.

## How this repo fits a two-stage workflow

Architecture, TRD authoring, and epic breakdown happen upstream (a Claude.ai Project);
this repo owns **implementation**. Expect to receive ticket-sized slices with acceptance
tests that must go red first. Anchoring work in particular should land against
adversarial test cases, not happy-path ones.

## Product invariants (govern every design and PR)

These come from the project brief, not from code, and are the non-obvious constraints an
implementer must respect. Flag it explicitly when a change violates one.

- **Annotations are advisory, never authority.** An agent must produce correct work when
  annotations are stale, wrong, or absent. Any design where a missing or outdated
  annotation causes a wrong action is broken.
- **Anchoring is the core hard problem.** Code moves (edits, renames, refactors, merges,
  rebases, reformatting). Price every feature against what it does to anchoring. An
  annotation that silently points at the wrong code is worse than none — degrade loudly,
  not quietly.
- **The MCP surface is a product API.** Few tools with sharp, prescriptive descriptions
  that state *when* to call them, not just what they do. Changes are additive and
  versioned. A tool description that drifts from actual behavior is a defect no prompt can
  fix.
- **Context is the scarce resource.** Every returned annotation enters an agent's context
  window and is paid for on every later turn. Query results are ranked and bounded by
  default — "the three that matter", never a full dump of everything attached to a file.
- **Two writers, one store.** Humans annotate in the editor; agents annotate over MCP.
  Provenance, trust level, and conflict behavior are part of the data model from day one.
- **Local by default.** Annotations may carry proprietary reasoning. Nothing leaves the
  machine without an explicit, visible user action.
- **The extension host is shared.** Never block the UI thread; use lazy activation events;
  do no startup work that a large workspace turns into a stall.

## Where the invariants live in code

The scaffold already encodes several of these; keep them enforced as the code grows.

- *Bounded context* → `AnnotationStore.query` in [store.ts](packages/mcp-server/src/store.ts)
  ranks and caps results (`DEFAULT_LIMIT = 3`). Never add an unbounded query path for agents;
  `all()` is for tooling/tests only.
- *Anchoring / degrade loudly* → [anchor.ts](packages/mcp-server/src/anchor.ts) captures a
  `snapshot` + `snapshotHash` on write and `driftStatus` returns `aligned | drifted | unknown`
  — `unknown` (never a fabricated `aligned`) when the code can't be read. The adversarial
  cases live in `test/anchor.test.ts`; extend them before improving re-anchoring.
- *Two writers, one store* → provenance/trust are on every record in
  [types.ts](packages/mcp-server/src/types.ts); the extension writes with `provenance: "human"`,
  the server with `"agent"`, through the same `AnnotationStore`.
- *MCP is a product API* → tool descriptions in [server.ts](packages/mcp-server/src/server.ts)
  state *when* to call each tool. If you change a tool's behavior, change its description in the
  same commit.
- *Lazy activation* → `activationEvents: []` in the extension `package.json`; VS Code activates
  only on first command use. Do not add startup activation.

## Ground-truth order

1. Docs the project supplies (spec, glossary, MCP notes) are authoritative.
2. Explicit in-session instructions override stale docs.
3. Never invent file paths, function names, schema fields, MCP method names, or VS Code
   API surfaces. If unknown, say so and verify against current docs — the MCP TS SDK and
   VS Code extension APIs change, so check them rather than recalling from memory.
