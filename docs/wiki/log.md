# Project Log

Running record of what's actually built and verified, most recent first. Not a
changelog of commits — a snapshot of state, so anyone (human or agent) can
answer "what does this repo do today" without reconstructing it from `git log`.

## 2026-08-15 — A multi-line annotation reads as one annotation

VS Code repeats `gutterIconPath` on **every** line of a decoration range —
verified in a real Extension Development Host, not assumed — so a three-line
note drew three identical bubbles and a thirty-line note would draw thirty.
Three icons read as three separate annotations.

[decorations.ts](../../packages/extension/src/decorations.ts) now splits the
job across two decoration types:

- the **icon** marks *where* the note is attached — first line only, no hover;
- the **spine** marks *how far* it reaches — a whole-line left border plus the
  existing tint across the range, and it carries the hover, so hovering
  anywhere in the span shows the note.

The hover lives on exactly one of the two on purpose: both cover the first
line, and two `hoverMessage`s there would show the note twice.

There is no bracket primitive in the VS Code decoration API. A true bracket
(arms at the top and bottom) would need three decoration types and three
SVGs, all kept aligned across a re-anchor — deliberately not taken, since
`updateDecorations` runs on every `onDidChangeTextDocument`, i.e. every
keystroke, and [the extension host is shared](../../CLAUDE.md).

**Verified**: `build`, `typecheck`, `lint` green, and a three-line annotation
driven live in a real dev host — one icon, spine spanning the range,
screenshotted before and after. Note the spine sits at column 0, the same
place VS Code draws bracket-pair guides; the brighter blue is what separates
them.

## 2026-08-16 — A re-anchor must win distinctively, not just win

Found while probing how anchoring behaves across git branches (a checkout is
just a wholesale content swap, so it can be simulated headlessly against
`@acciaccatura/core` — no VS Code needed).

`reanchor()` took the highest-scoring window, full stop. On a branch carrying a
near-identical copy of the annotated code — a refactor in progress, a legacy
fork of a function — the untouched copy scored 5/6 while the real, *edited*
original scored 4/6. The note silently attached to the wrong function, reported
no drift, and the heal was persisted; checking out the original branch healed it
back. The annotation ping-ponged between two functions.

[anchor.ts](../../packages/core/src/anchor.ts) now requires the winner to beat
the best **disjoint** rival by at least a quarter of the snippet. Overlapping
rivals don't count — repeated lines make neighbouring windows score alike, but
they describe the same region, not a different one. Below that margin the
result is `undefined`: [degrade loudly](standards/engineering-principles.md).

Worth stating plainly, because the first attempt was wrong: rejecting only
*ties* does not fix this. In the case above nothing tied — the decoy won
outright. The margin is what catches it, and
[anchor.test.ts](../../packages/core/test/anchor.test.ts) now pins both shapes
(tie, and decoy-outscores-original) plus the overlapping-rival case that must
still heal.

Effect on the branch scenario: on the branch with the decoy the note degrades
loudly instead of lying, and because no wrong heal is persisted, returning to
the original branch reads `aligned` again.

**Still open** — the wider question this came from: an anchor's line numbers
still overlay whatever occupies them on another branch, and healing remains
destructive (it overwrites the original capture). That is a lifecycle question —
are annotations permanent, or resolvable like a PR comment? — being decided
before any branch-aware anchoring is built.

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
