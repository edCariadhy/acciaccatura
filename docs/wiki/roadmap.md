---
type: reference
title: Roadmap
description: Project roadmap and current status of Acciaccatura
---

# Acciaccatura Roadmap

Acciaccatura provides AI-readable code annotations for VS Code, exposed to agents via an MCP server. This document outlines where we are and what is still missing, aligned with the project's invariants.

## Current State: What We Have

The foundational architecture is in place and the critical paths are working and tested:

### 1. Core Data & Model (`@acciaccatura/core`)
- **Shared JSON Store:** Read/write paths to `.acciaccatura/annotations.json` work. Supports ranking and bounded limits (`DEFAULT_LIMIT = 3`) to preserve agent context.
- **Trust & Provenance:** The data model successfully differentiates between human-authored (`authoritative`) and agent-authored (`suggested`) notes.
- **Robust Anchoring & Drift Detection:** Annotations capture a line range and a hash of the text snapshot. When code drifts, sliding window heuristics automatically re-anchor the annotations.

### 2. MCP Server (`@acciaccatura/mcp-server`)
- **Agent Read Path:** `get_annotations` tool is implemented, returning ranked, drift-checked annotations. Finished notes are left out.
- **Agent Write Path:** `annotate_code` tool is implemented, defaulting to `suggested` trust.
- **Maintenance:** `resolve_annotation` marks the work a note asked for as done; `remove_annotation` deletes a note that was wrong.

### 3. VS Code Extension (`@acciaccatura/extension`)
- **Human Write Path:** Command `acciaccatura.annotateSelection` allows developers to capture a note from a selection.
- **In-Editor Visibility:** Annotations show up as blue gutter icons next to line numbers, and provide hover tooltips with content. Lost annotations degrade loudly with a red warning on Line 1.
- **Management UI:** Sidebar Tree View lists all annotations grouped by file, enabling humans to easily review, delete, and promote agent suggestions to `authoritative`.
- **Performance:** Lazy activation is configured; zero startup cost. Bundled via `esbuild` for a zero-dependency `.vsix`.

---

## What is Still Missing: The Roadmap

### Phase 1: Robust Anchoring
- [x] **Fuzzy/Heuristic Re-anchoring:** Search heuristics implemented.
- [x] **Adversarial Testing:** Added tests for renames, large insertions/deletions, reformatting.
- [x] **Degrade Loudly UI:** Handled via Line 1 warning decorations.

### Phase 2: In-Editor Visibility & Management
- [x] **Inline Decorations:** Gutter icons and hover tooltips implemented.
- [x] **Management UI:** VS Code tree view implemented.
- [x] **Agent Suggestion Review:** `Promote to Authoritative` implemented.

### Phase 3: Annotation Lifecycle
*A note is a working note, not a permanent record — see [standards/storage-and-lifecycle.md](standards/storage-and-lifecycle.md).*
- [x] **Mark Done:** `resolve` records who finished the work. Finished notes leave `get_annotations` and the gutter, and keep their id.
- [x] **Reopen:** finishing a note can be undone.
- [x] **Delete Finished Notes:** `sweepResolved` takes a cutoff from the caller, never touches an open note, and never runs on a timer.
- [ ] **Age reporting:** surface how long notes have been open, so a workspace can see what it is carrying before it sweeps.

### Phase 4: Scopes — the next trajectory
*A named set of notes, with an order and a lifetime of its own. Decided in [standards/scopes.md](standards/scopes.md); it is what makes PR review and onboarding expressible.*
- [x] **`scope` and `order` on a note:** additive fields. Absent scope stays a plain working note, and a store written before this reads as belonging to no set.
- [x] **Scope-filtered read:** `get_annotations(scope)` returns a set in its order — the same call whether the caller wants a file's notes or a tour. A set read is bounded at 20 rather than 3, and asking for neither a file nor a scope is an error, not a full dump.
- [ ] **Shard by scope:** one file per scope, replacing the per-source-file plan. Reads the old single file, never breaks on it.
- [x] **Close a scope:** `resolveScope` finishes every open note in one call, for a merged PR, and reports how many. Closing twice is safe — the first answer stands. Over MCP it is a `scope` argument on `resolve_annotation`, not a new tool. Agents may close; only people delete.
- [x] **Staleness rollup:** `store.scopes()` lists every set from memory with no file reads; `reportScope` checks one set and counts its open notes as aligned / drifted / gone. Counts, never a score. Over MCP both are `scope_status`, with and without a `scope` argument. A set that does not exist reports as absent, not as a set with nothing wrong.

### Phase 5: The surface, in the right primitives
*MCP has tools, resources and prompts; we ship only tools. See [standards/mcp-surface.md](standards/mcp-surface.md).*
- [ ] **`update_annotation`:** repair a note's body or anchor without reissuing its id. The one genuinely missing verb — today an agent can only add, finish and delete, so it cannot fix a stale tour.
- [ ] **Scopes as resources:** the scope list and each scope as readable documents, so discovery costs no tool slot.
- [ ] **Procedures as prompts:** review-in-order, onboarding tour, stale-scope triage. Prompts, not a Claude-only skill, or non-Claude agents lose the workflow.

### Phase 6: Freshness
- [ ] **Watch the store:** the editor only re-reads when the active file changes, so a note an agent writes while you sit in one file stays invisible. Small, and visible today.

### Phase 7: Storage evolution — parked, with reasons
*We build a marketplace extension, so no native bindings: any future store must be pure JS or Wasm, never a pre-compiled binary per OS and architecture.*
- [x] **JSON as the baseline:** zero dependencies, works in the extension host. Measured at 2,000 notes: a 1 MB file, 1.9 ms to load, 0.02 ms per query. Keep it until something actually degrades.
- [ ] **Vector search — parked, not rejected.** It answers "find notes like this", which scopes answer better by naming the set. The database part is unnecessary at this scale anyway: brute-force cosine over 20,000 notes is ~12 ms and ~29 MB, four orders of magnitude from where an index earns its keep. The real cost is a ~23 MB embedding model on first run, CPU in a shared extension host, and an embedding that goes stale beside the anchor. Revisit only with evidence that agents are missing notes that scopes cannot reach.
- [ ] **Cross-file anchoring:** (Stretch) a function extracted into a new file.
