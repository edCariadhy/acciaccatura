# Project Log

Running record of what's actually built and verified, most recent first. Not a
changelog of commits — a snapshot of state, so anyone (human or agent) can
answer "what does this repo do today" without reconstructing it from `git log`.

## 2026-08-15 — Annotations keep their id across a re-anchor

Closes the known gap logged below. [store.ts](../../packages/core/src/store.ts)
gained `update(id, changes)`: an in-place edit that returns the updated record,
or `undefined` when no annotation has that id (it never resurrects a deleted
note). `id`, `createdAt`, and `provenance` are absent from `AnnotationUpdate` by
design — identity survives an edit, and who wrote a note is not editable after
the fact. A new anchor gets its `snapshotHash` re-derived through the same
`sealAnchor` helper `add` uses, so a healed anchor can't be persisted with a
stale hash and read as falsely drifted.

Both remove/add callers now go through it:

- [decorations.ts](../../packages/extension/src/decorations.ts) — the reanchor
  heal. An id handed out earlier (a cached MCP result, a tree-view selection)
  still resolves after the heal.
- [extension.ts](../../packages/extension/src/extension.ts) —
  `acciaccatura.reviewAnnotation` (Promote to Authoritative) had the same bug,
  and additionally reset `createdAt`. Promotion is now an edit: same id, same
  creation time, still attributed to the agent that wrote it.

The MCP tool surface is unchanged — no new tool, no changed description. This is
an additive core method, which the
[stable-contracts](standards/stable-contracts.md) policy allows.

**Verified**: `npm test` (37/37, four new cases in
[store.test.ts](../../packages/core/test/store.test.ts) covering identity,
hash re-derivation, unknown id, and persistence), plus `npm run build`,
`typecheck`, and `lint`.

## 2026-08-15 — Phase 1 (anchoring) and Phase 2 (in-editor UI) land

**Anchoring** — [anchor.ts](../../packages/core/src/anchor.ts) gained
`reanchor()`: a zero-dependency, line-based sliding window that re-locates a
drifted anchor in the current file text, ignoring whitespace so formatter runs
don't break it. Threshold is 100% match for snippets under 5 lines, 80% above
that. On success it returns an updated `Anchor` with a fresh `snapshot` +
`snapshotHash`; on failure it returns `undefined` — the caller must
[degrade loudly](standards/engineering-principles.md), never guess. Covered by
adversarial cases in
[anchor.test.ts](../../packages/core/test/anchor.test.ts): lines shifted up/down,
whitespace-only edits, heavy modification (correctly gives up), partial
matches at the threshold boundary.

`reanchor()` itself doesn't touch the store — [decorations.ts](../../packages/extension/src/decorations.ts)
is the only current caller, and it re-anchors reactively on editor render:
detect drift via `driftStatus`, call `reanchor`, and on success write the
healed anchor back. **Known gap (fixed 2026-08-15, see the entry above):** it
did that as `remove` + `add`, which reissued the annotation under a new `id`,
so anything holding the old one went stale across a heal.

**In-editor UI** — the extension can now show and manage annotations without
going through MCP:

- [decorations.ts](../../packages/extension/src/decorations.ts) — gutter icon
  + hover tooltip (body + trust level) on aligned/healed annotations; a red
  warning icon pinned to line 1 when an annotation is permanently lost
  (the reanchor-failed case above).
- [treeView.ts](../../packages/extension/src/treeView.ts) — an "Acciaccatura"
  activity-bar view listing every annotation, grouped by file. Right-click
  offers **Delete** always, and **Promote to Authoritative** only when
  `trust == "suggested"` (i.e. agent-written) — the human review step for
  [two-writers-one-store](../../CLAUDE.md).
- New commands in
  [package.json](../../packages/extension/package.json):
  `acciaccatura.refreshTree`, `acciaccatura.deleteAnnotation`,
  `acciaccatura.reviewAnnotation`, alongside the existing
  `acciaccatura.annotateSelection`.
- `activationEvents` stays `[]` — nothing here changes lazy activation.

**Verified**, not just built: `npm run build`, `npm test` (33/33), and
`npm run lint` are green, and the full flow (open file → select → Annotate
Selection → gutter icon appears → shows in the sidebar tree, grouped by file)
was driven live in a real Extension Development Host and screenshotted, not
just asserted in `vitest`. The container-icon SVG
([media/icon.svg](../../packages/extension/media/icon.svg)) renders correctly
but is easy to miss in the activity bar — it isn't a recognizable codicon
shape, worth a design pass later.

**Not yet verified**: the tree view's right-click context menu (delete /
promote) — VS Code renders it outside the DOM the current headless driver can
reach. The menu contributions are wired correctly in `package.json` (checked
by inspection), but nobody has clicked them.

### Next: Phase 3 — version control & collaboration

Annotations are local-only today (`.acciaccatura/annotations.json`, gitignored
by convention). Open question for Phase 3: explicit export/import, or a sync
strategy — and how that interacts with
[local-by-default](../../CLAUDE.md) and the
[on-disk schema contract](standards/stable-contracts.md).
