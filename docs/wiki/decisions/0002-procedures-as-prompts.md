---
type: decision
title: 0002 — Ship procedures as MCP prompts, not as a skill
description: Why a review walkthrough lives on the protocol rather than in a skill file, and why the first reason given for it was wrong.
status: accepted
date: 2026-08-17
---

# 0002 — Ship procedures as MCP prompts, not as a skill

**Status:** accepted · **Date:** 2026-08-17

## Context

A set of notes is a sequence, and working through one has steps the tools cannot
state on their own. `get_annotations(scope)` hands back a tour in order; nothing
in it says *read the code at each step, and believe the code when it disagrees*.

That is a workflow, and it had to live somewhere: a skill file, a tool, or an
MCP prompt.

## Options

### A tool

Rejected against the rule in
[../standards/mcp-surface.md](../standards/mcp-surface.md): a tool is a line in
the agent's tool list on **every turn**, paid whether or not it is ever called.
Measured, the three procedures come to roughly 1,100 tokens. As tools that is
1,100 tokens per turn forever; as prompts it is ~313 tokens to list them and one
procedure's worth only when someone runs it.

### A skill

The honest option, and the one this decision is really about.

**The first reason given for rejecting it was wrong.** The original argument —
in this repo's standard, its roadmap, a source comment and a test docstring —
was that a skill reaches one agent while the protocol reaches all of them.
Several agents read skills. The premise was false, and it was caught in review
rather than by anyone writing it.

Worse, it contradicted a rule the repo already had: *a description that has
drifted from the behaviour is a defect no prompt can fix.* If procedures were
frozen into a separate artefact for reach reasons, nothing said they had to
track the tools they drive.

### An MCP prompt

Taken. See below for the reason that survives.

## Decision

**Procedures ship as MCP prompts**, because a skill is a *second artefact*: it
has to be installed next to the server, kept in step by hand with the tools it
drives, and written in whatever format the agent in front of you reads.

A prompt arrives with the server that already serves the notes, in the protocol
the client already speaks. So a procedure cannot drift out of step with the
tools it calls — they ship together or not at all. That is the same rule the
tool descriptions follow, and separate artefacts are the surest way to break it.

Note what changed: the decision stayed, the reason was replaced. A skill may
still wrap these for nicer ergonomics on one client — the skill is a convenience
layer, the prompt is the source of truth.

## Consequences

- Three prompts exist: `review_change`, `onboarding_tour`, `repair_set`. Their
  full message text is pinned in the golden file, because the message *is* the
  procedure and it is the longest thing an agent reads from this server.
- The prompts must keep saying the notes are hints and the code wins. A
  procedure is where an agent learns how to treat a note; leaving it out teaches
  it to act on a stale one.
- Adding a prompt is cheap in a way adding a tool is not, which is its own risk:
  cheap-to-add is how surfaces sprawl. The bar stays "a workflow over the
  primitives", not "a thing that would be handy".

## What would change this

- **A client that cannot use prompts** becoming important enough to serve. That
  is a reason to *add* a skill wrapper, not to move the source of truth.
- **Evidence that agents ignore prompts in practice.** If a procedure is never
  invoked, it is not delivering the intent it was written for, and the answer is
  probably a tool description that points at it — not a new tool.

## Note on the reasoning

Kept deliberately: the argument was reached for because it sounded right, not
because it had been checked, and it survived into four places before review
caught it. A claim about what some other tool does today deserves the same
suspicion as an API signature — see
[../standards/mcp-surface.md](../standards/mcp-surface.md) §3 and the
2026-08-17 entry in [../log.md](../log.md).
