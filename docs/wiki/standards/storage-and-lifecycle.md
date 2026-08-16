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

One narrow exception, added later and written down in [scopes.md](scopes.md): a
**standing scope** — a curated tour across many files, in a set order. A comment
cannot say "read this third", so a tour is a different artefact rather than a
long-lived note. Single notes stay short-lived by default.

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

### Knowing what you are holding

Deleting asks the caller for a cutoff date and, for a long time, gave them
nothing to pick one with. `reportAge` is that missing half: open notes grouped by
how long they have waited, finished notes grouped by how long they have been safe
to delete, aged from `createdAt` and `resolvedAt` respectively because the two
answer different questions. Metadata only — it reads no code and opens no file.

Counts and buckets (`today`, `1-6 days`, `7-29 days`, `30+ days`), never a score,
for the same reason the staleness rollup gives counts: "6 open, 30+ days" is
something a reader can act on, where "health: 0.4" would be an authority we made
up. The edges are fixed rather than passed in — a caller choosing its own edges
is a caller choosing its own meaning — and a month is the edge that matters,
because a working note still open after a month has outlived the work it was
written for. A note whose date cannot be read is reported as `undated` rather
than dropped or filed under an age it never earned, so the split always adds up
to the total.

Both writers see it, in the form each can use. The editor has **How Old Are My
Notes?**, and the delete confirmation now says the ages of what it is about to
take rather than only the count — a number alone cannot tell six notes finished
this morning from six nobody has looked at since June. Agents get the narrow
part they can act on: `get_annotations` says how many days a note has been open
once it is older than a day. Deleting stays a person's decision, so the report
that leads to it was not worth a tool of its own — see
[mcp-surface.md](mcp-surface.md).

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

### What the default actually is

The product ships no `.gitignore` and writes none. So in a user's repository
`.acciaccatura/` **is committed unless they choose otherwise** — that is the real
default, and it is now a decision rather than an accident. It is what makes the
PR case in [scopes.md](scopes.md) work at all: the reviewer's agent reads the
writer's notes because they arrived with the diff.

Two corrections that follow:

- Earlier pages said `.acciaccatura/` was "ignored by default to keep proprietary
  reasoning local". That was never product behaviour. It described the
  `.gitignore` line in *this* repository, which exists only to keep the stores our
  own dev builds write out of version control.
- **Local by default means the product never transmits.** Nothing here opens a
  socket, and no note leaves the machine by anything Acciaccatura does. Committing
  and pushing is the user's own action, taken with the usual git tools and the
  usual review — which is exactly the "explicit, visible user action" the
  invariant asks for.

## 3. One shard per annotated source file — superseded

**Superseded by [scopes.md](scopes.md) §3: shard by scope, not by source path.**
Kept here because the reasoning matters more than the conclusion.

The plan was one path-mirrored file per annotated source file, e.g.
`.acciaccatura/notes/src/billing/pay.ts.json`. It rested on write cost: every
write rewrote the whole store, measured at 1.8 MB per added note in a 2,000-note
workspace, plus a full rewrite each time an anchor healed while the user typed.

That case has since gone:

- Notes are placed at read time now, so **rendering never writes** — the store
  file is byte-identical after a session of typing.
- Finishing and sweeping bound how far a store grows, so history no longer
  accumulates forever.
- Measured on the single file that remains: 2,000 notes is a 1 MB file that loads
  in **1.9 ms** and answers a file+line query in **0.02 ms**.

What was left was localised merge conflicts, in a mode we had already called
supported-not-blessed. That is not enough to reshape the store. Sharding by
scope, by contrast, follows the way the notes are actually used: a scope is the
set you hand over, end, and review.

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

- **Export/import is dropped, not deferred.** It existed to move notes between
  machines. The store is committed by default, so a PR's notes already travel
  with the PR. See [scopes.md](scopes.md).
- **Storage architecture absorbs this decision.** The JSON-baseline choice
  stands; scopes change the file granularity, not the format.
- **Discovery is answered by scopes**, not by a search index: an agent reads a
  short list of named sets instead of guessing which files hold notes.
  described above.
