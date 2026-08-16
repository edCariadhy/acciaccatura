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

### Phase 3b: Version Control & Collaboration
*Demoted by the storage decision: it assumed human-to-human sharing, which is not the product's centre.*
- [ ] **Export/Import Flow:** Since `.acciaccatura/` is ignored by default to keep proprietary reasoning local, provide an explicit way to export notes to a team-shared file or sync them securely.

### Phase 4: Storage Architecture & Extension Distribution
*We are building a VS Code extension intended for the marketplace. The choice of database must not complicate distribution across Mac/Windows/Linux and x64/ARM architectures.*
- [x] **JSON as the Baseline:** JSON requires zero dependencies and works perfectly in the extension host. It will last us through early adoption and should be kept until performance actively degrades.
- [ ] **Wasm / Pure-JS Databases:** When migrating away from JSON, we must avoid native Node.js bindings (like `better-sqlite3` or heavy C++ Vector DBs) which require pre-compiling binaries for every OS/Arch combination. We should evaluate:
  - **SQLite (Wasm):** e.g., `wa-sqlite` or `sql.js` for robust, cross-platform local querying without native build steps.
  - **Pure JS Search:** e.g., Orama or a local WebAssembly vector index (like Voy) for semantic search capabilities, keeping the extension bundle lightweight and universally compatible.
- [ ] **Model Management:** If we introduce local embeddings for vector search, we must handle downloading the model (e.g., ONNX weights via `Transformers.js`) cleanly on first run with a progress bar, so the extension itself remains small in the VS Code Marketplace.

### Phase 5: MCP Server Polish
- [ ] **Annotation Discovery Tool:** A tool for agents to ask "which files have annotations?" to help them explore a new codebase.
- [ ] **Cross-file Anchoring:** (Stretch) Handling annotations when a function is extracted and moved to an entirely new file.
