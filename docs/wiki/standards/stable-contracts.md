---
type: standard
title: Stable Contracts
description: How the MCP surface and the on-disk annotation schema may evolve without breaking consumers we do not control.
---

# Stable Contracts

Contracts with consumers we do **not** control evolve only by **adding and
deprecating** — never by renaming, removing, or re-typing what already exists.
Old annotation files and old agents keep working across a version boundary.
Everything whose only consumers are in this repo is **free to refactor**, guarded
by the tests.

This is modelled on the [Go 1 compatibility promise](https://go.dev/doc/go1compat):
adopt the whole machine, not the slogan. "Always backward compatible" with no
scope, no exceptions, and no escape hatch is a straitjacket; the machine below is
what makes the promise real.

## The two halves

| Boundary | Consumer | Rule |
| --- | --- | --- |
| **MCP tool surface** (`packages/mcp-server/src/server.ts`) | Any agent, anywhere | Additive only. Add new tools or new **optional** input fields; never rename a tool, change an existing field, or change the meaning an agent inferred from a description. |
| **On-disk schema** (`.acciaccatura/annotations.json`, `StoreFile`) | A user's real data, across versions | Additive + **tolerant reader** + `version`. Old files load unchanged; unknown fields are preserved; an unknown enum value (e.g. a future `trust`) downgrades, it does not crash. |
| **`@acciaccatura/core` internals** | Only `mcp-server` + `extension`, in this repo | Refactor freely. You own every caller; the tests catch you. |

## The add-and-deprecate rule (how to "rename")

At a closed boundary you never rename in place. To get the effect of a rename:

1. **Add** the new field/tool (extension).
2. Keep **reading** the old one (tolerant reader).
3. **Deprecate** it across a version boundary.
4. **Remove** it only at a major version.

## Borrowed from Go, on purpose

- **Scoped, not total.** Go's promise covers the spec + exported stdlib, not
  unexported internals. Our equivalent is the table above: contracts are frozen,
  `core` internals are not.
- **A written exceptions list.** Not covered by the promise: security fixes,
  genuine correctness bugs, and anything explicitly marked experimental. "Always,
  no exceptions" is dishonest — a security fix may have to break something.
- **An escape hatch.** If a *default behaviour* must change (ranking, drift
  semantics), gate it behind a setting so the old behaviour is recoverable
  (Go's `GODEBUG` analogue).
- **A major-version door.** Genuinely breaking changes wait for a major version —
  where deprecated fields and tools are finally dropped (Go 2 / `v2` analogue).
- **A golden API file.** Go pins its stable API in `api/*.txt` and fails CI on an
  unintended change. Ours is
  [surface.golden.md](../../../packages/mcp-server/test/integration/surface.golden.md),
  **built**, and it goes further than tool signatures: it holds every word an
  agent reads. Tool names, titles, descriptions and input schemas; the resource
  descriptions **and the documents themselves**; every prompt's description,
  arguments and full message text. `UPDATE_GOLDEN=1` accepts a change, and the
  question to answer then is not "did I mean this" but "is this additive".

  Two things learned building it, both worth keeping:

  - **A golden file that moves on its own is worse than none.** The first version
    embedded a set's `openedAt`, so it would have gone red on the next run for no
    reason — and a test that cries wolf teaches everyone to update it without
    reading it, which is the one failure this test cannot afford. Timestamps are
    masked; nothing else is.
  - **Descriptions are the largest part of the contract and the least guarded.**
    Names and schemas are hard to change by accident. A reworded sentence is not,
    and it reaches every agent that reads it to decide when to call something.

## Where our problem is harder than Go's

Go's promise is mostly **source** compatibility — your code recompiles. Ours is
**data at rest**: a user's annotations written by an old version must load in a
new one with the user doing nothing. Go never migrates your data; we do. The
tolerant-reader + `version` + migration work is therefore load-bearing, not
polish.

## Sequencing (we are pre-1.0)

At `0.x` the convention is "anything can break", and our anchoring model is still
moving. So:

- **Now:** build the machinery (MCP contract test **built**, store `version` check +
  tolerant reader + migration seam) and treat the MCP surface as additive-only by
  habit. The **store schema freezes first** — real user data exists the moment
  anyone uses the extension.
- **At 1.0:** make the formal promise, with the written exceptions list and the
  major-version door. The **tool surface freezes last.**

### The one time we nearly spent it — 2026-08-16

Sharding the store by scope looked like it needed a migration, and the call was
made to skip one: nothing is published, so no real user data exists yet.

It turned out not to cost anything. `annotations.json` is still the home for
notes in no set, so an old store file is a **valid input, not a legacy format** —
its scoped notes are read as they are and move to their own file the next time
anything is written. No migration step, and the licence to break went unused.

Worth remembering for the next time this comes up: the store is **committed to
git by default**, so "nobody uses it yet" stops being true the moment anyone
tries the extension and pushes. The window closes earlier than it looks.
