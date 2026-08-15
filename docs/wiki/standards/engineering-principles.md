---
type: standard
title: Engineering Principles
description: Reviewability-first, docs-in-the-same-PR, and the boring-decision bias that govern how code and docs change here.
---

# Engineering Principles

Companion to [stable-contracts.md](stable-contracts.md) and the product invariants
in the root `CLAUDE.md`.

## Reviewable by a human, always

A human must be able to read the change and understand it. The real lever is **PR
size**, not metrics: keep pull requests small and single-purpose. Complexity
metrics are crude and easily gamed; a 1,200-line PR is what actually defeats a
reviewer.

This is the tiebreaker against premature abstraction. Every layer of indirection
added for "flexibility" is a hop a reviewer must hold in their head, so indirection
lives **only at the [Stable Contracts](stable-contracts.md) boundaries** — never
inside `core`, which stays flat and concrete.

Necessary complexity is not forbidden — anchoring/re-anchoring is genuinely hard.
The rule is that complexity is **isolated, named, tested, and annotated**, not
absent.

## Docs change in the same PR as the code

Not "every PR touches docs" — that produces stale-by-mandate drive-by edits. The
rule: **when you change a thing, the doc for that thing changes in the same PR.**

- Authoritative docs live **in this repo** under `docs/wiki/`, reviewed with the
  code. There is no GitHub wiki (it bypasses review).
- The conformance floor is executable: `npm run docs:check` (see
  [frontmatter-schema.md](frontmatter-schema.md)). It runs in CI.
- Where possible, generate reference docs from the source of truth so they
  **cannot** drift (target: the MCP tool reference generated from `server.ts`).

## Prefer the boring decision

Price every added dependency, abstraction, process, or storage layer. Reach for
concrete code and the rule of three before extracting an interface: you learn the
right seam by building the second implementation, not by imagining it.
