---
type: standard
title: The MCP Surface
description: Which of MCP's three primitives each part of the product belongs to, why scopes are a parameter rather than new verbs, and why procedures do not live in a Claude-only skill.
---

# The MCP Surface

The MCP surface is the product. It is how every agent, in every editor, meets
Acciaccatura — so what goes on it, and in what shape, is a product decision
rather than an implementation one.

Companion to [stable-contracts.md](stable-contracts.md), which governs how the
surface may change once published.

## 1. Three primitives, three jobs

MCP offers **tools**, **resources**, and **prompts**. We ship only tools today,
which is why every new idea has looked like a new tool. It should not.

| primitive | holds | why |
|---|---|---|
| **Tools** | every write, and reads that must compute | Writes need one atomic path, a preserved id, and a re-derived hash. Reads like drift need the code compared against the note. |
| **Resources** | documents an agent reads | A scope, and the list of scopes, are documents with a name. `resources/list` gives discovery without a tool for it. |
| **Prompts** | procedures | "Review this change in order", "run an onboarding tour", "triage a stale scope" are workflows over the primitives, not primitives. |

The reason to care is attention, not tidiness. Every tool is a line in the
agent's tool list on every turn — spending the same scarce context that bounded
query results exist to protect. Resources and prompts are fetched when wanted.

## 2. Scopes are a parameter, not a set of verbs

A scope is a way of selecting notes, so it belongs in the arguments of the tools
that already select notes:

- `get_annotations(scope)` — reading a scope in order is the same call as reading
  a file's notes.
- `annotate_code(scope, order)` — writing a note into a set.
- `resolve_annotation(scope)` — finishing a whole set at once, so a twenty-note
  PR scope does not need twenty round trips.

Two genuinely new verbs survive that test:

- **`update_annotation(id, …)`** — repair a note's body or re-point its anchor,
  keeping its id. Nothing else can express it. Removing and re-adding reissues
  the id and drops the note's place in its scope, which is why "the tour needs
  updating" is currently impossible to say. **Built.** A re-anchor takes all four
  of `file`, `startLine`, `endLine` and `snapshot` or none: line numbers without
  the text they point at cannot be hashed, and a note re-anchored on a guess is
  the silent wrong answer the product exists to avoid. This is a *deliberate*
  re-anchor by a caller who has read the code, which is not the automatic
  rewriting that [storage-and-lifecycle.md](storage-and-lifecycle.md) §4 rules
  out. A call that would change nothing is refused rather than reported as a
  repair.
- **`scope_status(scope?)`** — how a set stands: counts of notes, and of open
  notes that are aligned, drifted, or gone. **Built.** It is a tool rather than a
  resource because it is a read that must *compute* — the code has to be
  compared against every note in the set, which is the same reason drift lives on
  a tool. The cheap listing and the per-set check are one tool with an optional
  argument, not two, because the argument is what the rule above asks for. It
  answers a different question from `get_annotations`: not "what should I know
  about this code" but "is this set still worth trusting, and can it go".

That leaves **six tools**: `get_annotations`, `annotate_code`,
`update_annotation`, `resolve_annotation`, `remove_annotation`, `scope_status`.
Read, write, repair, end, delete, judge — one verb each, no synonyms.

Six is not a target to grow into. Every tool is a line in the agent's tool list
on every turn, so the next addition has to clear the same bar these did.

### Age reporting stayed off the surface — 2026-08-16

Reporting how old notes are looked like a seventh tool and is not one. The
question it answers — *what is this workspace carrying, and what would a delete
take* — leads to `sweepResolved`, and deleting is a person's decision that no
agent may take. A tool an agent can call but never act on is a line of tool list
bought for nothing.

What an agent can act on is narrower, so that is all it got: `get_annotations`
already returns a note, and now says how many days it has been open once it is
older than a day. Notes are working notes, so an old one is likelier to describe
work that has already moved on — which is the kind of thing that changes how
much weight an agent gives it. No new tool, no new argument, a few tokens on a
line already being paid for. The full report belongs to the person about to
sweep, and lives in the editor.

## 3. Procedures do not live in a skill

A skill is one vendor's format. The product's whole reason to exist is
**IDE-agnostic intent delivered at the protocol layer** — solve it once so every
agent benefits, not only users of one tool. A walkthrough that lives in a Claude
skill does not exist for any other agent, which gives away the differentiator to
save a little work.

So: **procedures ship as MCP prompts**, which every MCP client can list and use.
A skill may wrap them for nicer ergonomics on one client. The skill is a
convenience layer; the prompt is the source of truth.

There is a second temptation worth naming. Because the store is committed and
human-readable JSON, an agent with file access can simply read
`.acciaccatura/scopes/*.json` — and a skill could just say so. That reads the
data but skips what the server adds: where the code sits now, whether it drifted,
and a bounded result. Reads that need computing stay on the protocol.

## 4. Rules for anything added later

- **A new tool must be a verb nothing else can express.** If it can be an
  argument to an existing tool, it is an argument.
- **A document is a resource.** If the answer is "here is a thing to read", it is
  not a tool.
- **A workflow is a prompt.** If the answer is "do these steps with the tools you
  have", it is not a tool.
- **Descriptions say when to call, not just what it does**, and change in the
  same commit as the behaviour. A description that has drifted from the code is a
  defect no prompt can fix.
