# Standards

Project law. These are constraints, not preferences; a change that violates one
must say so explicitly and justify itself.

- [stable-contracts.md](stable-contracts.md) — how the MCP surface and on-disk schema may evolve.
- [storage-and-lifecycle.md](storage-and-lifecycle.md) — what an annotation's life is, and the store layout that works committed or not.
- [scopes.md](scopes.md) — the named set a note belongs to, its lifetime, its file, and how staleness is reported.
- [mcp-surface.md](mcp-surface.md) — which MCP primitive each part of the product belongs to, and what may become a new tool.
- [engineering-principles.md](engineering-principles.md) — reviewability, docs-in-PR, and the boring-decision bias.
- [frontmatter-schema.md](frontmatter-schema.md) — the conformance floor every wiki page must meet.

The product invariants (advisory-not-authority, degrade-loudly, bounded context,
two-writers-one-store, local-by-default, shared extension host) live in the root
`CLAUDE.md` and are the companion to these standards.
