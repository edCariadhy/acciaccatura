---
type: decision
title: 0003 — What shape the store should be, so two writers cannot lose a note
description: Layouts weighed with measurements, and why the two note lifetimes want two shapes rather than one shape that serves neither.
status: accepted
date: 2026-08-17
---

# 0003 — What shape the store should be, so two writers cannot lose a note

**Status:** accepted · **Date:** 2026-08-17 · **Built:** 2026-08-17

Follows [0001](0001-store-write-safety.md), which stopped the bleeding with a
lock. This asks the question that lock deferred: if the layout itself made a
collision impossible, would the lock still be load-bearing?

## Context

Today every write rewrites every file the current list needs. Measured on a
2,000-note store, **adding one note writes 1,281 KB across 5 files — 2,154×
amplification**. That is not merely wasteful; it is the mechanism of the bug in
0001. Lost updates happen precisely because each writer saves the whole world,
so any two writers are always fighting over the same bytes.

Worth noting how this survived: `storage-and-lifecycle.md` retired an earlier
"shard by source file" plan on the grounds that its write-cost justification "no
longer exists", because rendering had stopped writing. Rendering did stop
writing. **Writes never stopped rewriting everything**, and nobody re-measured.

The governing rule for anything here comes from the product, not from taste:
**a lost note is never an acceptable trade.** Bounding growth is a user's
choice; losing someone's reasoning is not. That is the same rule that keeps
`sweepResolved` off a timer.

## Options

Numbers are medians on a 2,000-note store, APFS, this machine.

### 1. One file for everything, plus a lock — today

Cold read 2.4 ms. Write amplification 2,154×. The lock stands between every
writer and catastrophe, which makes it load-bearing, which makes every bug in
it a data-loss bug — and it has already had one.

### 2. An append-only log

Removes lost updates by construction: nobody rewrites anyone. Concurrent
`O_APPEND` was measured not to tear at 4 writers, records 64 B to 64 KB. Merges
cleanly in git, which matters because the store is committed so a PR's notes
reach the reviewer.

Costs: reads become replay, so it needs compaction — and retention is not a
substitute, because when the log **is** the state, dropping records by age drops
state. Independently confirmed by the local-first literature, where even CRDT
systems snapshot every ~10k ops. `O_APPEND` also carries no guarantee on NFS or
SMB.

### 3. A shared queue, hosted by a process

Attractive and collapses into a daemon: memory is not shared, so one process
must host it, and neither existing one can — the extension runs without the
server, the server without the extension, and stdio MCP servers are spawned per
client session. Electing the host is itself a lock. Worse, it damages
durability: either `add()` resolves on enqueue and the server tells an agent
"Saved" before the bytes exist, or it resolves on completion and the queue has
bought a hop, not a guarantee.

The instinct behind it is right, though — *one queue should own writes*. The
mistake is assuming a **process** has to host it. `O_APPEND` is that queue, and
the kernel hosts it.

### 4. One file per note — **taken for the loose bucket, see below**

A delete is `rm <id>.json`. No tombstones, no merge, no compaction. Write
amplification 1×. Two writers adding different notes cannot touch the same
path, so the catastrophic case is impossible rather than excluded.

Costs: cold read regresses as note count grows — see the built numbers below.
A directory of thousands of files is unpleasant to browse. Multi-note
operations like `resolveScope` become many writes (already true today for a
note that spans sets).

### 5. One file per writer, merged on read — **rejected on lifetime, see below**

Each writing session owns exactly one file, named by an id it generates at
startup. Readers merge every file and keep the newest record per id.

Three things make this the strongest of the five:

- **Its file needs no lock**, because it has exactly one writer. The lock stops
  being load-bearing and guards only the rare real conflict: two writers editing
  the *same* note.
- **The merge already exists.** `#readFromDisk` merges across files and dedupes
  by id keeping the higher `updatedAt` — built for the half-finished-move case
  in sharding, and exactly what this needs.
- **Reads do not regress.** Measured, 2,000 notes spread across writer files:

  | writers | notes/file | read + merge |
  | --- | --- | --- |
  | 1 | 2000 | 2.4 ms |
  | 50 | 40 | 2.4 ms |
  | 200 | 10 | 5.0 ms |
  | 500 | 4 | 9.9 ms |

  Fifty sessions cost what one file costs. The 38 ms in option 4 is the price of
  2,000 *notes*, not of many files.

A session file can also be **append-only**, which takes write amplification to
1× without needing `O_APPEND` atomicity, because there is only ever one appender.

#### The trap this design has to avoid

Partitioning by `provenance` — a `human.json` and an `agent.json` — looks like
the same idea and is not. It partitions the *labels*, not the writers: stdio MCP
servers are spawned per client session so several write `agent.json`, and two
VS Code windows on one workspace both write `human.json`. The partition key has
to be a per-session identity.

## Red team, and what it changed

Option 5 was the proposal until it was challenged on lifetime, and the challenge
held. **It partitions by writer, and a writer's identity has nothing to do with
how long a note lives.** One surviving standing-scope note pins its session file
forever, so compaction stops being maintenance and becomes load-bearing. Worse,
file count then grows with *sessions* — something a user cannot control by
tidying, unlike note count. For a store that is committed, 200 files you chose
is different from 500 files you got by opening the editor.

The rule that falls out: **partition by lifetime, not by writer.**

That reframes the whole question, because the two lifetimes in
[../standards/storage-and-lifecycle.md](../standards/storage-and-lifecycle.md)
want opposite things, and hunting for one shape to serve both is what made this
hard:

| | standing scopes | loose working notes |
| --- | --- | --- |
| lifetime | permanent, curated | short, swept |
| churn | low | high |
| read by | a person, in a diff | the sidebar and MCP |
| file count | few, and bounded by how many tours exist | self-limiting, because sweeping removes them |
| right shape | **one readable file per scope — what we already have** | per-note files, or a log |

The "many files forever" objection is real and lands entirely on the standing
half, which already has the right layout. It does not reach the short-lived
half, because those files come and go with the notes.

## Decision

**Taken, in two steps.** Standing scopes are left exactly as they were — one
readable file per set is right for something a person curates and reviews in a
diff. The **loose-note bucket** — high-churn, short-lived, unbounded — is the
one that changed, because it put every unscoped note in a single file that got
rewritten in full on every write.

1. **Write only the files whose contents changed.** No format change. Measured
   on a 2,000-note store, a scoped write drops from 1,256 KB across 7 files to
   43.5 KB across 1, and two writers working on different sets stop colliding
   entirely rather than always. **Built.** A file is serialised first and
   written only when those exact bytes differ from what it already holds, so
   the check can never skip a file that needed saving.
2. **Split the loose bucket into option 4: one file per note.** **Built.**
   Confirmed against a real red team of option 5 first (below) rather than
   assumed — a note's id is a UUID handed out internally, so it needs no
   escaping the way a typed set name does, and a note file is *deleted* once
   its note is gone rather than emptied like a scope file: there is nothing for
   an empty note file to mean, and a tombstone for every note ever created is
   exactly the git litter this was chosen to avoid.

The lock from [0001](0001-store-write-safety.md) stays, demoted to guarding
same-file edits and anything that writes without it.

### What building it actually measured

The option-5 table above was a synthetic benchmark — parallel `readFile` calls,
no integrity checking. Numbers from this repo's real store, after both steps:

| loose notes | add one note | cold load |
| --- | --- | --- |
| 100 | 0.6 KB / 1 file, 2.9 ms | 2.6 ms |
| 500 | 0.6 KB / 1 file, 14.9 ms | 13.1 ms |
| 2,000 | 0.6 KB / 1 file, ~70 ms | ~60–70 ms |

Write amplification is 1× exactly as predicted, at every count — a change to
one note touches one file, full stop. Cold read grows with note count, worse
than the ~38 ms option 4 originally cited, because that number timed a raw
`Promise.all(readFile)` and the real store's `readWithMark` does three `stat`
calls per file to detect a read landing mid-write — see
[0001](0001-store-write-safety.md). At a realistic count this does not matter;
past roughly 500 it is the cost of not having swept.

**A real bug found in the process, not a rounding difference.** `#readFromDisk`
read every file sequentially — harmless when there were only ever a handful of
scope files, but it became the dominant cost the moment loose notes could
number in the thousands: 165 ms cold at 2,000 notes before the fix below, not
the ~65 ms in the table above. Reads are now issued with `Promise.all`; nothing
depended on order, since each file's mark and digest are keyed by its own path
and the newer-wins merge that combines them is commutative. Worth remembering
alongside 0001's own lesson: measuring the change you meant to make is not the
same as measuring the whole path it runs on.

## Consequences

- **Two shapes means two code paths**, and a note moving between loose and
  scoped changes shape. That move already existed for scope-to-scope moves —
  see the gaining-before-losing ordering in
  [../standards/storage-and-lifecycle.md](../standards/storage-and-lifecycle.md)
  — and now has a second variant, gaining-before-*deleting*, for a note
  entering or leaving the loose bucket. `notes-crash.test.ts` proves the second
  one the same way `shard-crash.test.ts` proves the first: by mocking the write
  a crash would interrupt and checking the note survives on disk.
- **No tombstones.** Per-note files were chosen over per-writer files
  specifically to avoid them — a delete is `rm`, full stop. This is the actual
  payoff of the choice; option 5 would have needed them.
- **Deletes need the same conflict check writes do**, extended rather than
  duplicated: `#checkUnchanged` now covers files about to be deleted as well as
  files about to be written, so a delete raced by an external write is caught
  the same way a write raced by one is.
- **Reads must be issued in parallel**, or note-file count becomes the
  bottleneck it was measured to be — see "what building it actually measured"
  above. This is now load-bearing, not incidental: a future change to
  `#readFromDisk` that goes back to a sequential loop would quietly reintroduce
  the 165 ms figure at scale.
- **A cap on notes is a separate question from any of this.** What grows here
  is loose-note *files*, and `sweepResolved` is what bounds that — never a
  count cap that refuses a write. A note you could not save fails the same rule
  as a note that was lost, only louder.
- **Git gets better.** Separate files cannot conflict, and a diff shows which
  notes changed rather than a churned rewrite of one large file.
- **Reading one file no longer shows the whole store.** The sidebar and the MCP
  surface are the reading surfaces, so this is a small loss, but it is a loss.

## What would change this

- **Go to option 2, a real queue (option 3, itself collapsing into option 2),
  or a CRDT** only if the store ever has to replicate across machines. At that
  point this stops being a local-file layout question and becomes replication,
  and merge-by-newest stops being sufficient — last-writer-wins on a note body
  is fine, on anything critical it is not.
- **Revisit per-note files** if a workspace's `notes/` directory in practice
  grows large enough that cold-read cost (see the table above) becomes a
  complaint despite sweeping — the fix at that point is more aggressive
  sweeping defaults, not a different file shape.
- **Give scope files the same never-empty-if-unwritten treatment note files
  get** only if tombstoning ever turns out to matter for a set too — nothing
  today suggests it does, since a set is meant to be reviewed as a whole and an
  empty one is informative rather than litter.
