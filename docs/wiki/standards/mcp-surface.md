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

Only one genuinely new verb survives that test:

- **`update_annotation(id, …)`** — repair a note's body or re-point its anchor,
  keeping its id. Nothing else can express it. Removing and re-adding reissues
  the id and drops the note's place in its scope, which is why "the tour needs
  updating" is currently impossible to say. The core already does this correctly;
  it has simply never been exposed.

That leaves **five tools**: `get_annotations`, `annotate_code`,
`update_annotation`, `resolve_annotation`, `remove_annotation`. Index, read,
write, repair, end, delete — one verb each, no synonyms.

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
