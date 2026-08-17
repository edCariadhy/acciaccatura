# Decision Records

Why the design is the way it is: the options that were on the table, the one
that was taken, and **what would change it**.

## Why these exist next to the standards

The three kinds of page here do different jobs, and the gap between them is
where knowledge was going missing:

| page | answers | tense |
|---|---|---|
| [standards/](../standards/index.md) | what to do | present, prescriptive |
| [log.md](../log.md) | what got built and verified | past, chronological |
| **decisions/** | why, and what was rejected | a moment, with its reasoning |

A standard tells you the rule. It does not tell you that a cheaper option was
tried first and failed, so the next person tries it again — which has already
happened here more than once. `storage-and-lifecycle.md` prescribed a fix for
two-writer data loss that was implemented exactly as written and did not work,
and `mcp-surface.md` argued for prompts over skills on a premise that was not
true. Both were caught in review rather than by a reader, and neither page had
anywhere to record the near-miss.

## When to write one

Write a record when a choice is **hard to see from the code afterwards**:

- an option was rejected for a reason the code cannot show — cost, a measurement,
  a product invariant;
- the obvious approach was tried and failed;
- the decision constrains later work, such as anything touching an on-disk
  format or the MCP surface;
- reasonable people would land somewhere else, so "why not X" needs an answer.

Do **not** write one for a choice the code explains, or for something with no
real alternative. A record nobody needed is a page that goes stale and misleads.

## How

Copy [template.md](template.md), take the next number, keep the numbering flat.
A record is **immutable once merged**: correct it by adding a newer record that
supersedes it and linking the two, never by editing history. That is the point —
the reasoning at the time is what a reader needs, including where it was wrong.

## Records

| # | decision | status |
|---|---|---|
| [0001](0001-store-write-safety.md) | One writer at a time, by lock, across processes | accepted |
| [0002](0002-procedures-as-prompts.md) | Procedures ship as MCP prompts, not as a skill | accepted |
