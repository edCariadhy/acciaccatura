---
type: standard
title: Scopes
description: The named set a note belongs to, how long each kind of set lives, how sets are stored, and how an agent decides one has gone stale.
---

# Scopes

A note today is found one way: by the file and line it is anchored to. That
answers "what should I know about this code". It cannot answer "what should I
review first in this change", or "walk me through billing" — and those are two
real uses this product is for.

Both want the same missing thing: **a named set of notes, with an order, and a
lifetime of its own.**

## 1. A scope is a named set of notes

A note gains two optional fields:

- **`scope`** — a name, like `pr/142` or `onboarding/billing`. Absent means the
  note belongs to no set, which is the plain working note we have today and stays
  fully supported.
- **`order`** — where the note sits in the set's sequence.

Order is the point. "Review the migration before the handler" is a sequence, and
a sequence is information that ranking cannot produce: similarity says what looks
alike, never what to read first. This is also why a scope is not a search result
— a search is computed and different every time, a scope is written down and
stays put.

Scope names carry a `kind/name` shape by convention, not by rule. The store does
not parse them.

### Two bounds, because the two reads differ

A file read stays at three. A set read defaults to **twenty**.

Three is right for a file, where notes collect by accident and the caller wants
the few that matter. A set is the opposite: someone sat down and chose what goes
in it and in what order, so its size is already a decision, and a twelve-note
tour cut to three is not a tour.

It stays bounded either way. There is no "read the whole set", because a set
somebody let grow to five hundred would flood a context window just as surely as
a file dump. For the same reason a read must name a file or a scope — asking for
neither is an error, not a request for everything, since an unbounded path
reachable by leaving out an argument would be found by accident.

## 2. Two kinds of scope, two lifetimes

| | ephemeral | standing |
|---|---|---|
| example | `pr/142` | `onboarding/billing` |
| ends when | the work merges | the code moves under it |
| typical size | a few notes on one change | a curated tour across many files |
| prune signal | everything in it is finished, or it is simply old | drifted and gone notes climb |

**This amends "annotations are short-lived by default"** in
[storage-and-lifecycle.md](storage-and-lifecycle.md), and the amendment is
narrow. A single long-lived note is still better written as a code comment: a
comment travels with the code for free. But a comment cannot say *"read this
third"*, and it cannot hold a path across twelve files. A curated tour is a
different artefact, so a **standing scope is the named exception** — sequence and
selection are what it adds, and neither fits in the source.

Lifetime therefore belongs to the scope, not to the product. A note in `pr/142`
is expected to die; a note in `onboarding/billing` is expected to be maintained.

## 3. One file per scope

```
.acciaccatura/scopes/pr-142.json
.acciaccatura/scopes/onboarding-billing.json
```

This **replaces the one-file-per-source-file plan** in
[storage-and-lifecycle.md](storage-and-lifecycle.md) §3, which was justified by
write cost that no longer exists — a 2,000-note store now loads in 1.9 ms and
queries in 0.02 ms, and nothing rewrites the store on render since notes are
placed at read time. Sharding by source path would have bought localised merge
conflicts and nothing else we need.

Sharding by scope buys things we do need:

- **The scope is the unit you hand over.** A PR's notes travel with the PR
  because they are one file next to the diff.
- **The scope is the unit you end.** Closing or deleting a set is one file
  operation, not a filter across a shared blob.
- **The scope is the unit you review.** A reviewer sees `scopes/pr-142.json`
  change, and the whole set reads top to bottom in order.

What it costs, knowingly:

- **The file+line lookup now spans scope files.** "Notes on `src/pay.ts:12`" has
  to consider every scope. At twenty scopes of fifty notes that is about a
  megabyte — a couple of milliseconds by the same measurement. Acceptable now;
  it needs an index if a workspace ever holds hundreds of scopes, and that
  threshold should be measured, not guessed.
- **Moving a note between scopes moves it between files.** It keeps its id.
- **Unscoped notes still need a home** — they stay in the store file that exists
  today, which the reader must keep understanding.

### Built

- **File names are readable, not reversible.** `pr/142` becomes
  `scopes/pr__142.json`, because a reviewer reads these in a diff. Anything
  outside a safe alphabet is escaped, so a set called `feature/../etc` cannot
  climb out of the folder. The set's real name lives inside the file, so the
  mapping never has to be undone — it only has to be unique, and two sets that
  would land on one file are **refused loudly** rather than quietly merged.
- **A move is two writes, and nothing is atomic across two files.** The gaining
  file is written before the losing one, so a crash in between leaves the note in
  *both* — a duplicate the next read heals by keeping the newer copy — instead of
  in neither, which nothing could recover.
- **An emptied set file is emptied, not deleted**, so a reviewer sees the set was
  cleared. A shared file that never existed is not created just to hold nothing.
- **The old single file still loads.** It is what a store with no sets looks
  like, and scoped notes found in it move to their own file on the next write.
  No migration step, and none of the pre-1.0 licence to break was spent.

## 4. Staleness is reported, never scored

An agent has to be able to ask whether a standing scope still describes the code,
and whether an ephemeral one can go. It gets counts, not a verdict:

```
onboarding/billing — standing — 12 notes — 7 aligned, 3 drifted, 2 gone
pr/142 — ephemeral — 8 notes — 8 finished — opened 6 days ago
```

Every number there is already computed per note on each read. A single
"staleness: 0.72" would be a made-up authority; "2 notes point at code that is
gone" is something an agent can act on. This is the same rule as drift itself:
say what is true and let the reader decide.

Cost forces a split between the index and the check. Listing scopes must stay
cheap metadata with no file reads, because a workspace may hold many. Checking
one scope reads the code for that scope only. Reading a tour and checking whether
the tour is still true are then the same operation.

**Built**: `store.scopes()` is the index — counts and dates straight from memory,
no file reads at all. `reportScope(scope, …)` is the check, and reads each file
once however many notes point into it. Only *open* notes are checked: a finished
note's code being gone is not a problem to report, and counting it would push an
agent to repair a set that is already done. A scope that does not exist reports
as absent rather than as a row of zeroes, because "no such set" and "a set in
good shape" are different answers. Both are reached over MCP as `scope_status`.

**The product cannot know that a PR merged.** Reading git on a query path is out
(see [storage-and-lifecycle.md](storage-and-lifecycle.md) §2), so merge is never
detected — it is *reported* by whoever did it. Age and "everything finished" are
hints in the listing, and nothing prunes on its own.

## 5. Agents close, people delete

- **Closing** a scope finishes every note in it. It is reversible, it keeps the
  record, and an agent may do it — that is the prune verb. **Built**:
  `store.resolveScope(scope, by)` reports how many notes it finished, skips
  notes already finished so the first answer stands, and is reached over MCP as
  a `scope` argument on `resolve_annotation` rather than a tool of its own.
- **Deleting** throws away someone's reasoning. It stays a person's decision with
  an explicit yes, as settled for `sweepResolved` in
  [storage-and-lifecycle.md](storage-and-lifecycle.md).

The asymmetry is the point: the blast radius of a wrong close is an undo, and the
blast radius of a wrong delete is lost work.

## 6. Both writers reach a set

Scopes started agent-only: an agent could read a set, check it and close it over
MCP, while a person could do none of those. That left **two writers, one store**
true for notes and false for sets.

The editor now has the same three verbs — **Check Set**, **Close Set**, and
**Add Note to Set** — and the sidebar lists sets above the files, read in the
author's order. Two rules the editor has to keep, both learned by running it:

- **A set is never shown as checked until someone checks it.** Checking reads
  code and the sidebar redraws constantly, so a set with no check reads "not
  checked" and never "0 drifted". Claiming everything matches before looking is
  a false answer a reader acts on.
- **A check is dropped as soon as anything is written.** A check counts only
  *open* notes, so closing a set — or finishing one note in it — leaves the last
  check describing notes nobody is reporting on. Stale counts are worse than
  none.
