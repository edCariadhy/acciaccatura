# @acciaccatura/mcp-server

MCP server that exposes [Acciaccatura](../../README.md) code annotations to AI
agents over stdio. Annotations live in a JSON file inside the workspace and
never leave the machine.

License: **AGPL-3.0-or-later** (the extension is MIT; this server is not).

## Run

```bash
npm run build --workspace @acciaccatura/mcp-server
node packages/mcp-server/dist/index.js
```

Configuration (environment variables):

| Variable                 | Default                                   | Purpose                                  |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| `ACCIACCATURA_WORKSPACE` | `process.cwd()`                           | Root that anchor paths resolve against.  |
| `ACCIACCATURA_STORE`     | `<workspace>/.acciaccatura/annotations.json` | JSON store location.                  |

## Tools

- `get_annotations` — bounded, ranked lookup of notes for a file/line. Reports a
  drift status per note so a stale annotation degrades loudly.
- `annotate_code` — persist a durable, non-obvious note anchored to a line range.
- `remove_annotation` — delete a confirmed-obsolete note.

Tool descriptions state *when* to call each one; keep them in sync with behavior.

## Design invariants

See the root [CLAUDE.md](../../CLAUDE.md). In short: annotations are advisory
(the code always wins), anchoring drift must surface not hide, query results are
bounded, and nothing leaves the machine without explicit user action.
