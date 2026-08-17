---
type: decision
title: 0001 — Hold a lock across the whole read-change-save
description: Why two processes writing to the store need a real lock, and why the two cheaper answers were tried first and did not work.
status: accepted
date: 2026-08-17
---

# 0001 — Hold a lock across the whole read-change-save

**Status:** accepted · **Date:** 2026-08-17

## Context

The editor and the MCP server are separate processes, and both write to the same
store. Each reads the whole thing, changes it, and saves it back.

Nothing stopped one saving over the other. Measured before anything was changed:

| writers | pacing | result |
| --- | --- | --- |
| 2 | 40 ms apart | **one writer's notes lost in full, 5 runs out of 5** |
| 2 | flat out, 25 notes each | roughly half of 50 lost, every round |

Every write reported success. This is the failure mode the product can least
afford: it is someone's reasoning, gone silently, and
[../standards/engineering-principles.md](../standards/engineering-principles.md)
asks the system to degrade loudly.

## Options

### 1. A write queue (already existed, kept)

An in-memory promise chain in `AnnotationStore.#mutate`, with reads queued behind
writes so a re-read cannot replace the list a write is about to save.

It fixed a real bug — two MCP tool calls arriving together lost a finished note
3 times out of 3 before it, and none after. It cannot help here, because it lives
in one process's memory and the other process cannot see it.

### 2. Re-read then rename atomically — the one that looks obvious

This is what [../standards/storage-and-lifecycle.md](../standards/storage-and-lifecycle.md)
§4 prescribed, and it was implemented exactly as written. **It still loses
notes.** Optimistic checking answers *"did somebody write before me?"*, and the
question that matters is *"is somebody writing at the same moment as me?"*.

Instrumented, two writers on the same cadence fall into step:

```
A| [check] before=221823226:491:…  now=221823226:491:…  same
B| [check] before=221823226:491:…  now=221823226:491:…  same   <- identical
```

Both read the same file, both find it unchanged, both save. The window is
between the check and the rename, and no amount of checking closes it.

**If you are about to remove the lock because re-reading looks sufficient: this
is the paragraph for you.** It is not sufficient. It was measured.

### 3. An append-only log, one record per change

Writers append rather than rewrite, so nobody can save over anyone: the race
goes away by construction rather than by exclusion. Concurrent `O_APPEND` writes
were measured not to tear, at 4 writers and record sizes from 64 B to 64 KB, all
of which land intact.

It also merges cleanly in git, which matters here — the store is committed by
default so a PR's notes reach the reviewer, and today two branches that both
touched notes conflict on one pretty-printed file.

Not taken **now**, for three reasons, none of them fatal: reads become a replay
and so need compaction, which is itself a whole-file rewrite needing this same
lock, only rarely; the on-disk format is a stable contract, so the change has to
land before 1.0 rather than casually; and a diff stops showing state and starts
showing history, which costs the reviewer something the cleaner merges only
partly repay. Also measured on APFS — `O_APPEND` atomicity is not guaranteed on
NFS or SMB, and a workspace can sit on a network share.

### 4. One dedicated writer process

Rejected. Neither existing process can be it: the extension runs without the
server, the server runs without the extension, and MCP servers are spawned per
client session so several can exist at once. It therefore means a daemon —
lifecycle, socket, crash recovery, a single point of failure, and background
work on a product whose invariants are *local by default* and *the extension
host is shared*. Electing which process is the writer is itself a lock, so the
primitive does not go away; it moves, with a daemon on top.

## Decision

**A real lock, held from the read to the last rename.** `withStoreLock` creates
`.acciaccatura/.lock` with `wx`, which either creates the file or fails, in one
step the kernel will not split — the only primitive here two processes can agree
on.

The optimistic check from option 2 is **kept as a second line**, for anything
that writes without taking the lock: an older build still running, or a person
editing the file by hand.

After: nothing lost at two writers 40 ms apart, or at six writers flat out.

## Consequences

- **The lock is not FIFO.** It is mutual exclusion with jittered retry: one at a
  time, no guaranteed order. A writer that keeps losing waits longer, bounded by
  a 5-second acquire timeout, after which it throws rather than hanging. Notes
  are independent, so order does not currently mean anything.
- **A crash must not wedge the store**, so a lock nobody has touched for ten
  seconds is taken over, and the lock is released in a `finally` so a failed
  write does not leave one behind either.
- **Staleness is judged by the lock file's own timestamp, never by what is
  written inside it.** `wx` creates the file and fills it in as a second step,
  so a lock taken a microsecond ago can still be empty. The first version of
  this read that empty file, failed to parse it, called it rubbish and deleted a
  lock somebody was holding — two writers inside at once, the exact thing it
  exists to prevent. Two processes at a human pace never caught it; four flat
  out lost a few notes a round, scattered, every write still reporting success.
- **The lock is store-wide**, although sharding already puts different sets in
  different files. Per-file locks would cut contention and need no format change.
- **The guarantee needs real processes to test.** Two `AnnotationStore`
  instances inside one process share the write queue and pass happily, which is
  the false assurance that let this survive as long as it did.
  `packages/core/test/two-processes.test.ts` spawns them.

## What would change this

- **Move to the append-only log** if git conflicts on the store become a real
  complaint, or if per-write lock contention shows up in practice. That decision
  should be made **before 1.0**, because the on-disk format is a contract — see
  [../standards/stable-contracts.md](../standards/stable-contracts.md).
- **Go to per-file locks** if a workspace with many active sets feels slow to
  write. Cheap, and no format change.
- **Revisit the lock primitive** if the store ever has to work on a network
  filesystem, where neither `wx` nor `O_APPEND` carries the guarantees measured
  here.
