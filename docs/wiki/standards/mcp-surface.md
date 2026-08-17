---
type: standard
title: The MCP Surface
description: Which of MCP's three primitives each part of the product belongs to, why scopes are a parameter rather than new verbs, and why procedures ship as prompts rather than as a skill.
---

# The MCP Surface

The MCP surface is the product. It is how every agent, in every editor, meets
Acciaccatura — so what goes on it, and in what shape, is a product decision
rather than an implementation one.

Companion to [stable-contracts.md](stable-contracts.md), which governs how the
surface may change once published.

## 1. Three primitives, three jobs

MCP offers **tools**, **resources**, and **prompts**. Tools came first, which is
why every new idea looked like a new tool for a while. It should not.

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

## 2a. The sets are resources — built

Two of them, both `text/plain`:

| URI | is |
|---|---|
| `acciaccatura://scopes` | the index: every set, what it holds, how old it is |
| `acciaccatura://scopes/{+scope}` | one set, its open notes in the author's order |

The template's `list` callback enumerates every set, so `resources/list` answers
"what is here" with no tool call spent and no line added to the tool list. That
is the whole point: a tool is paid for on every turn whether or not it is used,
and a resource is fetched only when wanted.

Three things this design had to get right:

- **`{+scope}`, not `{scope}`.** Set names are `kind/name` by convention, and
  RFC 6570's plain expansion percent-encodes the slash and then fails to match
  its own URI back. The reserved expansion carries it through. A client that
  encodes anyway still gets its set: the read tries the name as given first, so
  a name genuinely containing a percent escape is not broken by the fallback.
- **A resource states no position as current.** It reads no code, so it cannot
  know whether a note's lines still hold. It says "written at 12-18" and points
  at `get_annotations` for where the code is now and whether it drifted. A
  position given without that caveat is the quiet wrong answer the product
  exists to avoid — the same reason drift is a tool and not a resource.
- **Absent is not empty, and finished is not empty.** A set that does not exist
  is an error, not a blank document. A set whose notes are all finished says so,
  because "the work this set was for is over" and "nobody ever wrote into it"
  are different facts.

Finished notes are left out of the reading but counted in the header, and the
reading is bounded by the same `DEFAULT_SCOPE_LIMIT` an agent gets from
`get_annotations`. A resource is read on demand rather than on every turn, but
it lands in the same context window when it is.

### The capability has to be honoured, not just advertised

The SDK advertises `resources.listChanged` as soon as a resource is registered,
and that entitles a client to list the sets once and then wait to be told. So
the server now sends `notifications/resources/list_changed` when a write
actually changes which sets exist — a note creating a set, the last note leaving
one, a note moved out. Finishing a note sends nothing, because a finished note
still belongs to its set, and a notification on every write would train a client
to re-list for no reason.

This covers writes made **through the server**. A set the person creates in the
editor still arrives late: nothing watches the store yet (Phase 6). Every read
reloads first, so the answer is never wrong, only later than it could be.

## 3. Procedures do not live in a skill

Skills are a real option, and several agents read them — this is not an argument
about reach, and an earlier version of this page that made it one was wrong.

The reason procedures still ship as **MCP prompts** is that a skill is a *second
artefact*. It has to be installed next to the server, kept in step by hand with
the tools it drives, and written in whatever format the agent in front of you
reads. The notes already arrive over MCP; a prompt arrives with them, from the
same server, in the protocol the client already speaks. So the procedure cannot
drift out of step with the tools it calls — they ship together or not at all —
and nothing extra has to be installed for the workflow to exist.

That is the same rule the tool descriptions follow: a procedure that has drifted
from the behaviour it describes is a defect no prompt can fix, and the surest way
to cause that drift is to keep the two in separate artefacts.

A skill may still wrap these for nicer ergonomics on one client. The skill is a
convenience layer; the prompt is the source of truth.

**Built** — three, each taking a `scope`:

| prompt | for |
|---|---|
| `review_change` | a set holding the notes for one change under review |
| `onboarding_tour` | a standing walkthrough of an area |
| `repair_set` | a set `scope_status` reports as drifted or gone |

Four rules they all follow, and each is a thing that would have been easy to get
wrong:

- **They say the code wins.** Every one opens by saying the notes are hints, not
  instructions, and that where a note and the code disagree the note is what is
  wrong. A procedure is where an agent learns how to treat a note, so leaving
  that out would teach it to act on a stale one.
- **They send the agent through the tools, and paste nothing in.** A prompt that
  copied the notes into its message would hand over a snapshot that stopped
  being true when it was written, with no drift in it. The message says which
  tool to call and in what order; the answers come back live.
- **They will not end a set on their own.** `review_change` says not to close —
  closing means the change merged, which is the author's call. `onboarding_tour`
  says not to close and not to finish the notes: a standing walkthrough is meant
  to outlive any one reading, and an agent that "completed" it would take it
  away from the next person.
- **Repair re-points, and never on a guess.** `repair_set` sends a drifted note
  to `update_annotation` with all four anchor fields, so the note keeps its id
  and its place. It says outright that a note moved onto code that merely looks
  similar is worse than a note that says loudly it cannot be placed.

Asking for a set that does not exist is an error that **names the sets that do**,
so a typo is a one-step fix rather than a guess. Set names complete from the
store, in prompt arguments as well as in the resource template.

The SDK advertises `prompts.listChanged` here too, and unlike the resource list
this one needs no notification: these three are registered once and the list
never changes. If a prompt is ever registered conditionally, that stops being
true and the same fix the resource list got applies.

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
