---
type: reference
title: Wiki Frontmatter Schema
description: The conformance floor every docs/wiki page must meet, enforced by npm run docs:check.
---

# Wiki Frontmatter Schema

The conformance **floor** for `docs/wiki/`, enforced by `npm run docs:check`
(`scripts/docs-check.mjs`). A floor, not a ceiling — pages may carry more.

## Rules

1. **Frontmatter `type`.** Every non-reserved `.md` file starts with a YAML
   frontmatter block containing a non-empty `type`. Allowed values:
   `standard`, `reference`, `guide`, `log`.
2. **Reserved files.** `index.md` (section router) and `log.md` are exempt from
   the `type` requirement.
3. **Portable relative links.** Every internal markdown link is **relative** (no
   leading `/`, no `file://`, no absolute machine paths) and resolves to a file
   that exists on disk. Leading-slash links dead-link in file and web viewers
   because `/` resolves against the filesystem/server root, not the bundle.
4. **No wikilinks.** No `[[double-bracket]]` links — standard markdown only.

## Why relative-and-resolvable

The bundle must be readable wherever it is checked out or mirrored, so links are
resolved against the page's own location, with the correct `../` depth. The gate
catches wrong depth, moved/renamed targets, and non-portable leading-slash links.
