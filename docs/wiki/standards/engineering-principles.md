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

## Write so a B2 reader can follow it

Pull request titles and bodies, commit messages, wiki pages, code comments, and
every string a user sees are written at **CEFR B2** level. This is a rule, not a
style note: the audience includes people who read English as a second language,
and an agent that has to guess at a word is a reader too.

- Use the plain word. "Written by", not "provenance". "Hard case", not
  "adversarial case". "Overwrite", not "clobber". "A hint, not a rule", not
  "advisory". "Fail in the open", not "degrade loudly".
- Words the product defines — annotation, anchor, drift, snapshot — stay. They
  are the shared vocabulary, and swapping them for near-synonyms costs more than
  it saves. Define each one once, then use it.
- Short sentences. One idea each. Say the result before the reason.

**Code names follow a different rule: short, and they state intent.** That is the
whole test for an identifier. Reading level does not apply here, so never rewrite
a name to hit a vocabulary level, and do not churn names that already read well —
a rename costs every reader who knew the old one. Rename only when the name is
genuinely unclear about what the thing is for.

`provenance` and the trust values `authoritative` / `suggested` / `unverified`
**stay as they are** — decided 2026-08-16. They are written to disk and read by
agents over MCP, they say exactly what they mean, and carrying a second name for
them would cost every reader and every stored file while buying nothing. They are
part of the product's vocabulary now.

Prose is still prose: when a wiki page or a message to a user explains one of
them, write "who wrote it" rather than making the reader parse the field name.

## Prefer the boring decision

Price every added dependency, abstraction, process, or storage layer. Reach for
concrete code and the rule of three before extracting an interface: you learn the
right seam by building the second implementation, not by imagining it.
