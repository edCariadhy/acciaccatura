# Acciaccatura

![Acciaccatura](media/banner.png)

**Review your agent's work.** Leave durable, AI-readable notes on code — intent, constraints,
gotchas, decisions — right in the editor. Any MCP-capable agent (Claude Code, Copilot, Cursor,
and others) reads the same notes through the [Acciaccatura MCP server](https://github.com/edCariadhy/acciaccatura/tree/master/packages/mcp-server),
so context you leave for an agent isn't locked to one IDE.

> An *acciaccatura* is a grace note: a tiny note sounded just before the main one that colours
> how it's heard. A small annotation that shapes how an agent reads the code that follows.

## What it does

- **Annotate a selection.** Select code, run **Acciaccatura: Annotate Selection**, and write a
  note. It's saved locally to `.acciaccatura/annotations.json` in the workspace.
- **See notes in the gutter.** Annotated lines get a gutter icon; hover it for the note body and
  the author's trust level.
- **Manage notes from the sidebar.** The Acciaccatura activity-bar view lists every annotation,
  grouped by file. Right-click to delete a note, or promote an agent-suggested note to
  authoritative once you've reviewed it.
- **Degrades loudly, never silently.** If code moves, the extension re-anchors the note
  automatically. If it can't — the code was deleted or changed beyond recognition — you get a
  clear warning instead of a note quietly pointing at the wrong lines.

## How it fits with agents

Notes you write here, and notes an agent writes over MCP, live in the same store. Provenance
(`human` vs `agent`) and trust level travel with every note, so an agent knows to treat a
suggested note differently from an authoritative one — and you can review and promote agent
notes from the sidebar before they're trusted.

Notes are advisory, never authority: an agent is expected to produce correct work even when a
note is stale, wrong, or missing.

## Getting started

1. Install the extension.
2. Select some code and run **Acciaccatura: Annotate Selection** (Command Palette).
3. Open the **Acciaccatura** view in the activity bar to see and manage all notes in the
   workspace.
4. To let an agent read and write notes too, point it at the MCP server — see the
   [project README](https://github.com/edCariadhy/acciaccatura#use-the-mcp-server) for setup.

## Privacy

Notes are stored locally in the workspace (`.acciaccatura/annotations.json`, gitignored by
default). Nothing leaves your machine unless you choose to share the file yourself.

## Status

Early and under active development. See the
[project repository](https://github.com/edCariadhy/acciaccatura) for source, issues, and the
MCP server.

## License

MIT
