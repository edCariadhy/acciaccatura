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
- [x] **Age reporting:** `reportAge` groups open notes by how long they have waited and finished notes by how long they have been safe to delete — counts and buckets, never a score, and a date it cannot read is reported rather than dropped. The editor has **How Old Are My Notes?**, and the delete confirmation now says the ages of what it would take, not only the count. Deleting is a person's decision, so this did not earn an MCP tool; agents get the part they can act on, `get_annotations` saying how many days a note has been open.

### Phase 4: Scopes — the next trajectory
*A named set of notes, with an order and a lifetime of its own. Decided in [standards/scopes.md](standards/scopes.md); it is what makes PR review and onboarding expressible.*
- [x] **`scope` and `order` on a note:** additive fields. Absent scope stays a plain working note, and a store written before this reads as belonging to no set.
- [x] **Scope-filtered read:** `get_annotations(scope)` returns a set in its order — the same call whether the caller wants a file's notes or a tour. A set read is bounded at 20 rather than 3, and asking for neither a file nor a scope is an error, not a full dump.
- [x] **Scopes in the editor:** sets appear in the sidebar above the files, read in their author's order, and carry counts. **Check Set** reports aligned / drifted / gone; **Close Set** finishes a set after asking, recording `human`; **Add Note to Set** puts a note at the end of a set, keeping its id. Until this, every scope verb was agent-only, so "two writers, one store" held for notes but not for sets.
- [x] **Shard by scope:** one file per set under `.acciaccatura/scopes/`, notes in no set staying in `annotations.json`. Reads the old single file unchanged — no migration step was needed, because the old file is still a valid input and its scoped notes relocate on the next write. Moving a note between sets writes the gaining file before the losing one, so a crash leaves a duplicate the next read heals rather than a note nothing could recover.
- [x] **Close a scope:** `resolveScope` finishes every open note in one call, for a merged PR, and reports how many. Closing twice is safe — the first answer stands. Over MCP it is a `scope` argument on `resolve_annotation`, not a new tool. Agents may close; only people delete.
- [x] **Staleness rollup:** `store.scopes()` lists every set from memory with no file reads; `reportScope` checks one set and counts its open notes as aligned / drifted / gone. Counts, never a score. Over MCP both are `scope_status`, with and without a `scope` argument. A set that does not exist reports as absent, not as a set with nothing wrong.

### Phase 5: The surface, in the right primitives
*MCP has tools, resources and prompts; we ship only tools. See [standards/mcp-surface.md](standards/mcp-surface.md).*
- [x] **`update_annotation`:** repairs a note's body, anchor, trust or place in a set without reissuing its id. Taken before sharding because the staleness rollup shipped detection with no remedy: an agent could see `1 drifted` and had no verb to fix it. A re-anchor needs all four anchor fields together, and a call that changes nothing is refused rather than reported as a repair.
- [x] **Scopes as resources:** `acciaccatura://scopes` is the index and `acciaccatura://scopes/{+scope}` is one set, read in its author's order. The template lists every set, so `resources/list` answers "what is here" with no tool call spent and no line added to the tool list. The reserved expansion `{+scope}` is what keeps the slash in `pr/142`; the plain form encodes it and then fails to match its own URI back. A resource reads no code, so it says where each note was **written** and sends the reader to `get_annotations` for where the code is now.
- [x] **Procedures as prompts:** `review_change`, `onboarding_tour` and `repair_set`, each taking a `scope`. Prompts, not a Claude-only skill, so no agent loses the workflow. Each opens by saying the notes are hints and the code wins, sends the agent through the tools rather than pasting notes into the message, and refuses to end a set on its own — closing a review is the author's call, and a standing walkthrough is meant to outlive any one reading. Repair re-points a drifted note with `update_annotation` and never on a guess.

### Phase 6: Freshness
- [ ] **Watch the store:** the editor only re-reads when the active file changes, so a note an agent writes while you sit in one file stays invisible. Small, and visible today.

### Phase 7: Storage evolution — parked, with reasons
*We build a marketplace extension, so no native bindings: any future store must be pure JS or Wasm, never a pre-compiled binary per OS and architecture.*
- [x] **JSON as the baseline:** zero dependencies, works in the extension host. Measured at 2,000 notes: a 1 MB file, 1.9 ms to load, 0.02 ms per query. Keep it until something actually degrades.
- [ ] **Vector search — parked, not rejected.** It answers "find notes like this", which scopes answer better by naming the set. The database part is unnecessary at this scale anyway: brute-force cosine over 20,000 notes is ~12 ms and ~29 MB, four orders of magnitude from where an index earns its keep. The real cost is a ~23 MB embedding model on first run, CPU in a shared extension host, and an embedding that goes stale beside the anchor. Revisit only with evidence that agents are missing notes that scopes cannot reach.
- [ ] **Cross-file anchoring:** (Stretch) a function extracted into a new file.
