---
type: standard
title: Storage Layout and Annotation Lifecycle
description: What an annotation's life is, and how the store is laid out on disk so it works identically whether or not the user commits it to git.
---

# Storage Layout and Annotation Lifecycle

Two decisions that govern everything downstream: **what an annotation's life is**,
and **where annotations live on disk**. They are settled together because the
first determines what the second has to survive.

## 1. Annotations are short-lived by default

An annotation is a **working note between collaborators** — human to agent,
agent to agent — attached to code for as long as the work is in flight. It is
not a permanent record of intent.

**If a note is genuinely long-lived, an inline code comment is the better tool**
and Acciaccatura should say so rather than compete with it. A comment travels
with the code through every refactor, rebase, and merge for free — that is
precisely the guarantee an external anchor has to work hard to approximate and
still only approximates. Durable architectural intent belongs in the source, in
a design doc, or in this wiki. This is a **non-goal**, not an omission.

What follows from that:

- **Expiry and resolution are first-class**, not a later feature. A store whose
  natural state is "notes accumulate forever" is the wrong shape. **Built** —
  see [How a note ends](#how-a-note-ends) below.
- **Anchoring precision matters most in the short term.** A note that lives for
  days rarely meets a rebase. This retires a large class of speculative work —
  cross-file anchoring, history-aware re-anchoring — until evidence demands it.
- **Bloat is primarily a lifecycle problem**, not a compression problem. Notes
  that end when the work ends do not grow without bound.

## How a note ends

A note carries `resolvedAt` and `resolvedBy` (both optional, both absent while it
is open — so a note written before these existed reads as open, not finished).
Three steps, and no fourth:

- **Finish it.** `store.resolve(id, by)` records who decided the work was done.
  The note keeps its id, stays on disk, and leaves the agent-facing query and the
  gutter. Both writers reach it: `resolve_annotation` over MCP, **Mark Done** in
  the sidebar or the command palette. Finishing is not an overwrite — the first
  answer stands, so two writers ending the same work do not fight.
- **Undo it.** `store.reopen(id)` puts the note back in play. Finishing is a
  judgement, and judgements are wrong sometimes.
- **Delete it.** `store.sweepResolved({ resolvedBefore })` deletes notes finished
  at or before a cutoff the caller picks, and never touches an open note whatever
  its age. The boundary includes the cutoff itself, so "everything finished so
  far" does not spare a note finished in the same millisecond. **Nothing sweeps on
  a timer.** Throwing away someone's reasoning is a person's decision, so it runs
  from an explicit command with an explicit yes.

Finished notes are excluded from `store.query` by default — `includeResolved`
brings them back for review UIs. The filter runs *before* the result cap, or a
few finished notes would eat the three slots an agent gets.

## 2. Git-agnostic by construction

The store **must behave identically whether or not `.acciaccatura/` is committed**.
Committing is the user's choice, and nothing in the product may assume either
answer.

The reasoning is that the collaboration Acciaccatura serves is *human to agent*
and *agent to agent* — not human to human. Git is a human-to-human
synchronisation channel. Treating "commit the annotations" as the answer to
sharing would optimise for the audience this product is not primarily for, and
would foreclose collaboration substrates that do not exist yet — an agent-first
shared workspace being the obvious one.

Concretely:

- **Nothing may require git to be present.** A workspace that is not a
  repository is a fully supported case, not a degraded one.
- **No git command may sit on a read or render path.** The extension host is
  shared; shelling out per keystroke is not acceptable.
- **Branch and commit are metadata, never keys.** Record which branch and commit
  a note was captured on, use it for reporting and filtering, and never use it
  as a storage key, a lookup path, or a correctness input. Branch is unstable by
  nature: rebases rewrite history, worktrees and detached HEAD have no
  meaningful name, and the same code lives on many branches at once.
- **Committed is a supported mode, not the blessed one.** When a user does
  commit, the layout must produce sane diffs and localised merge conflicts —
  see below — but the product must never behave *better* only in that mode.

## 3. One shard per annotated source file

Annotations are stored **one file per annotated source file**, path-mirrored:

```
.acciaccatura/notes/src/billing/pay.ts.json     <- notes anchored in src/billing/pay.ts
.acciaccatura/notes/src/store.ts.json
```

Replacing the single `.acciaccatura/annotations.json`.

Why this layout serves both modes:

- **Loading is proportional to what is open**, not to workspace history. The
  editor reads the shard for the file being rendered; the MCP server reads the
  shard for the file being queried. A workspace with thousands of notes costs
  what a file's worth of notes costs.
- **Writes stop being global.** Today every write rewrites the entire store —
  measured at 1.8 MB rewritten per added note in a 2,000-note workspace, and a
  full rewrite each time an anchor heals while the user types. Sharding bounds a
  write to the file it concerns.
- **Two writers stop colliding by default.** The editor annotating one file and
  an agent annotating another no longer touch the same bytes.
- **Merges localise, if committed.** A conflict lands in the shard for one
  source file instead of in one workspace-wide JSON blob that every branch edits.
- **Diffs are legible.** A reviewer sees `notes/src/pay.ts.json` change next to
  `src/pay.ts`.

What it costs, accepted knowingly:

- **Renaming a source file leaves its notes file behind** until something matches
  them up again.
  The anchor already carries the path, so reconciliation is possible; it is not
  free.
- **Cross-file questions need an index.** "Which files have annotations?"
  (roadmap Phase 5) becomes a directory walk or a maintained index rather than a
  filter over one array.
- **Many small files.** Fine for git and for filesystems; worth revisiting only
  if a workspace ever holds enough shards to make directory walks slow.
- **Path mirroring has edge cases** — case-insensitive filesystems, path length
  limits, files outside the workspace root. The shard stores its source path
  internally so the filename is a convenience, not the source of truth.

## 4. Requirements this decision imposes

Sharding narrows these problems; it does not by itself solve them, and a change
that ignores them re-introduces the defect at a smaller scale.

- **Read before write, then write atomically.** Two processes currently each
  hold the whole store in memory and rewrite it, so the last writer silently
  destroys the other's work — reproduced with a human note erased by an agent
  note. Every write must re-read the shard, merge, and rename a temp file into
  place. **Reads queue with writes too**: a re-read that lands in the middle of a
  write replaces the list that write is about to save. Two MCP tool calls
  arriving together lost a finished note this way, 3 times out of 3.
- **Never persist a re-anchor.** The capture is immutable; where a note
  currently sits is derived at read time. This removes the extra writes
  described above, and stops a note moving onto a near-copy of the code on
  another branch. See the entries in [../log.md](../log.md).
- **Bound what one note can cost.** A snapshot is 47% of a record's bytes while
  the note itself is 9%. Cap the snapshot, cap the body, and keep the agent-facing
  query bounded independently of disk size — context and disk are different budgets.
- **Schema changes stay additive.** Shard files are an on-disk contract with
  consumers we do not control; see [stable-contracts.md](stable-contracts.md).
  The migration from a single `annotations.json` must read the old file, not
  break on it.

## 5. Effect on the roadmap

- **Phase 3 (export/import for team sharing) drops in priority.** It assumed
  human-to-human distribution as the collaboration model. It is not wrong, but
  it is not the product's centre.
- **Phase 4 (storage architecture) absorbs this decision.** The JSON-baseline
  choice stands; this changes the file granularity, not the format.
- **Phase 5 (annotation discovery) gains a prerequisite** — the cross-file index
  described above.
