---
type: decision
title: 0003 — What shape the store should be, so two writers cannot lose a note
description: Five layouts weighed with measurements, and why one writer per file is the one that removes the conflict rather than excluding it.
status: proposed
date: 2026-08-17
---

# 0003 — What shape the store should be, so two writers cannot lose a note

**Status:** proposed · **Date:** 2026-08-17

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

### 4. One file per note

A delete is `rm <id>.json`. No tombstones, no merge, no compaction. Write
amplification 1×. Two writers adding different notes cannot touch the same
path, so the catastrophic case is impossible rather than excluded.

Costs: cold read 38 ms at 2,000 notes versus 2.4 ms — 16× worse, because it is
2,000 file reads. A directory of thousands of files is unpleasant to browse.
Multi-note operations like `resolveScope` become many writes.

### 5. One file per writer, merged on read — **proposed**

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

## Decision

**Proposed, not taken.** One file per writing session, merged on read, is the
shape that removes the conflict instead of excluding it. The lock from
[0001](0001-store-write-safety.md) stays, demoted to guarding same-note edits.

Not taken yet because the on-disk layout is a contract
([../standards/stable-contracts.md](../standards/stable-contracts.md)) and the
lock has already stopped the data loss. This is the shape to move to
deliberately, before 1.0, not under pressure.

## Consequences

- **Deletes need tombstones.** A person deleting a note held in another
  session's file cannot edit that file, so it writes a tombstone. A tombstone
  may only be dropped once no writer file still carries that id, or the note
  resurrects. Compaction reads everything anyway, so it is the same pass.
- **Files grow with sessions**, so compaction is needed — for files, not for
  notes. A cap on notes is a separate question, and if one exists it should warn
  and never refuse: a note you could not save fails the same rule as a note that
  was lost, only more loudly.
- **Compaction is lossless and idempotent even when it is wrong.** Fold in a
  session's file believing it dead, and if that session is alive and writes
  again you get duplicates — which heal on the next read, because the merge
  keeps the newest per id. Getting liveness wrong costs nothing. That property
  is what makes the whole design tractable, and it is rare in this class.
- **Git gets better.** Separate files cannot conflict, and a diff shows which
  notes changed rather than a churned rewrite of one large file.
- **Reading one file no longer shows the store.** The sidebar and the MCP
  surface are the reading surfaces, so this is a small loss, but it is a loss.

## What would change this

- **Take it** when write amplification or lock contention shows up in practice,
  or when a second human annotating the same repo makes clean git merges matter.
  Decide before 1.0, because it is a format change.
- **Prefer option 4** if tombstones turn out worse in practice than many files.
  Per-note files pay no tombstone tax at all, and that is their real advantage.
- **Go to option 2 or a CRDT** only if the store ever has to replicate across
  machines. At that point this stops being a layout and becomes replication, and
  merge-by-newest stops being sufficient — last-writer-wins on a note body is
  fine, on anything critical it is not.
