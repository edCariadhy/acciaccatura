# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Acciaccatura** — AI-readable code annotations for VS Code. Developers and agents
attach durable notes to code (intent, constraints, gotchas, decisions); agents query
and act on those notes through an MCP server. The differentiator is IDE-agnostic intent
delivered at the protocol layer: solve it once over MCP so every agent benefits, not just
users of one IDE.

Stack: TypeScript on Node 20+, an npm-workspaces monorepo. The MCP server uses
`@modelcontextprotocol/sdk` (installed: 1.30.0) + `zod`; unit/integration tests use
`vitest`; the extension bundles with `esbuild` and has real end-to-end tests via
`@vscode/test-electron`.

## Layout

Three packages, dependency order `core → { mcp-server, extension }`:

- `packages/core` — **licensed MIT**. The shared annotation model, JSON store, anchoring/
  drift logic, and the pure `annotationFromSelection` helper. No `vscode`, no MCP — just
  the domain. Both other packages depend on it. **Build first.**
- `packages/mcp-server` — **licensed AGPL-3.0-or-later**. Only the MCP glue (stdio server +
  tool definitions) over `@acciaccatura/core`.
- `packages/extension` — the VS Code extension (human writer), **licensed MIT**. Thin
  `vscode` command (`acciaccatura.annotateSelection`) wrapping a testable `capture` seam
  that writes to the same core store with `provenance: "human"`.

The three licenses are deliberate: `core` is MIT so the **MIT** extension can reuse it
without linking the **AGPL** server. Do not make the extension depend on `mcp-server`, and
keep shared/domain logic in `core` rather than duplicating it.

## Commands (verified working)

Run from the repo root. Workspace scripts fan out via `--workspaces --if-present`.

```bash
npm install                 # install all workspaces
npm run build               # build core → mcp-server (tsc) + extension (esbuild)
npm test                    # vitest: core unit + mcp-server integration + extension unit
npm run typecheck           # tsc --noEmit across workspaces
npm run lint                # eslint (flat config) over all packages
npm run docs:check          # docs/wiki conformance floor (frontmatter, portable links)
```

Standards & docs live in-repo under [docs/wiki/](docs/wiki/index.md) (there is no GitHub
wiki — it would bypass review). Change the doc for a thing in the same PR as the thing;
`docs:check` runs in CI.

Write PR text, commits, docs, comments and user-facing strings at **B2 English**. Code
names are judged differently — short and stating intent, never rewritten to hit a reading
level. `provenance` and the trust values keep their names for good. The rule and the word
swaps are in
[docs/wiki/standards/engineering-principles.md](docs/wiki/standards/engineering-principles.md).

`npm test` needs no prior build: the in-repo vitest configs alias `@acciaccatura/core`
to its TypeScript source, so the suites run from a clean checkout. Scoped / single test:

```bash
npm run build --workspace @acciaccatura/core          # deps build first
npm test --workspace @acciaccatura/core -- test/anchor.test.ts   # one file
npm test --workspace @acciaccatura/mcp-server -- -t "drifted"    # one test by name
```

Extension end-to-end (launches a real VS Code, downloads it on first run — kept OUT of
`npm test`):

```bash
npm run test:e2e --workspace acciaccatura
```

Smoke-test the server over stdio (initialize + list tools):

```bash
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node packages/mcp-server/dist/index.js
```

Server config via env: `ACCIACCATURA_WORKSPACE` (anchor-resolution root, default cwd) and
`ACCIACCATURA_STORE` (default `<workspace>/.acciaccatura/annotations.json`).

CI: [.github/workflows/ci.yml](.github/workflows/ci.yml) — a `unit` job (build + typecheck +
vitest) on every push/PR, and a heavier `e2e` job (real VS Code under xvfb, Linux-only, VS
Code cached) gated to PRs + a nightly cron, never plain pushes.

Note: `npm audit` reports dev-only advisories in vitest's transitive `esbuild`/`vite`
(the esbuild dev-server issue) — not in shipped code. The fix is a breaking vitest v4 bump;
left for a deliberate upgrade, not an incidental one.

Lint with ESLint 9 flat config ([eslint.config.mjs](eslint.config.mjs), typescript-eslint):
`npm run lint` (or `lint:fix`). It's part of the CI `unit` job. There is no Prettier;
don't invoke a `prettier` script that doesn't exist.

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
  fix. A new tool must be a verb nothing else can express: if it can be an argument, it is
  an argument; a document is a resource; a workflow is a prompt. See
  [docs/wiki/standards/mcp-surface.md](docs/wiki/standards/mcp-surface.md).
- **Context is the scarce resource.** Every returned annotation enters an agent's context
  window and is paid for on every later turn. Query results are ranked and bounded by
  default — "the three that matter", never a full dump of everything attached to a file.
- **Two writers, one store.** Humans annotate in the editor; agents annotate over MCP.
  Provenance, trust level, and conflict behavior are part of the data model from day one.
- **Local by default.** Annotations may carry proprietary reasoning, so the product itself
  never transmits: no network calls, no sync, no telemetry carrying note content. The store
  IS committed by default (we ship no `.gitignore`), because that is how a PR's notes reach
  the reviewer — but that is the user's own git action, not something the product does.
- **The extension host is shared.** Never block the UI thread; use lazy activation events;
  do no startup work that a large workspace turns into a stall.
- **Stable Contracts.** Contracts with consumers we don't control — the MCP tool surface and
  the on-disk annotation schema — evolve only by *adding and deprecating*, never by renaming,
  removing, or re-typing what exists (old files and old agents keep working). Code with only
  in-repo consumers (`@acciaccatura/core` internals) is free to refactor. Full policy, with the
  Go-1-compatibility framing and pre-1.0 sequencing:
  [docs/wiki/standards/stable-contracts.md](docs/wiki/standards/stable-contracts.md).

## Where the invariants live in code

The code already encodes several of these; keep them enforced as it grows.

- *Bounded context* → `AnnotationStore.query` in [store.ts](packages/core/src/store.ts)
  ranks and caps results (`DEFAULT_LIMIT = 3`). Never add an unbounded query path for agents;
  `all()` is for tooling/tests only.
- *Anchoring / degrade loudly* → [anchor.ts](packages/core/src/anchor.ts) captures a
  `snapshot` + `snapshotHash` on write and `driftStatus` returns `aligned | drifted | unknown`
  — `unknown` (never a fabricated `aligned`) when the code can't be read. Snapshots are
  newline-normalized before hashing so CRLF files don't read as falsely drifted. The
  adversarial cases live in `packages/core/test/anchor.test.ts`; extend them before improving
  re-anchoring.
- *Two writers, one store* → provenance/trust are on every record in
  [types.ts](packages/core/src/types.ts); the extension writes `provenance: "human"` (via
  [capture.ts](packages/extension/src/capture.ts) + `annotationFromSelection`), the server
  writes `"agent"`, through the same `AnnotationStore`.
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
