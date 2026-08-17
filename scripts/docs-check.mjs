#!/usr/bin/env node
// Docs conformance gate for an in-repo wiki bundle. Zero dependencies.
//
// Enforces the floor in docs/wiki/standards/frontmatter-schema.md:
//   [A] every non-reserved .md has YAML frontmatter with a non-empty `type`
//   [B] no [[wikilinks]]
//   [C] internal markdown links are relative (no leading /, no file://, no abs
//       machine path) and resolve to a file that exists on disk
//
// Usage: node scripts/docs-check.mjs [rootDir]   (default: docs)
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const ROOT = resolve(process.argv[2] ?? "docs");
const RESERVED = new Set(["index.md", "log.md"]);
const ALLOWED_TYPES = new Set(["standard", "reference", "guide", "log", "decision"]);

/** @type {string[]} */
const violations = [];
const fail = (file, msg) => violations.push(`${relative(process.cwd(), file)}: ${msg}`);

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith(".md")) check(p);
  }
}

function frontmatterType(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const block = text.slice(4, end);
  const m = block.match(/^type:\s*(.*)$/m);
  return m ? m[1].trim() : null;
}

// Strip fenced (```…```) and inline (`…`) code so example syntax inside code
// spans — including docs that describe the rules — is not linted as content.
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
}

function check(file) {
  const text = readFileSync(file, "utf8");
  const base = file.split("/").pop();

  // [A] frontmatter type on non-reserved files
  if (!RESERVED.has(base)) {
    const type = frontmatterType(text);
    if (!type) fail(file, "missing non-empty `type` in YAML frontmatter");
    else if (!ALLOWED_TYPES.has(type))
      fail(file, `type "${type}" not in {${[...ALLOWED_TYPES].join(", ")}}`);
  }

  const prose = stripCode(text);

  // [B] no wikilinks
  if (/\[\[[^\]]+\]\]/.test(prose)) fail(file, "contains [[wikilink]] — use standard markdown");

  // [C] internal links relative + resolvable
  for (const m of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue; // external / anchor-only
    if (/^file:\/\//.test(target) || /^\/(Users|home)\//.test(target))
      { fail(file, `non-portable link: ${target}`); continue; }
    if (target.startsWith("/")) { fail(file, `leading-slash (non-portable) link: ${target}`); continue; }
    const path = target.split("#")[0];
    if (!path) continue; // pure anchor
    const resolved = resolve(dirname(file), path);
    try { statSync(resolved); } catch { fail(file, `broken link: ${target}`); }
  }
}

try {
  statSync(ROOT);
} catch {
  console.error(`docs-check: root not found: ${ROOT}`);
  process.exit(2);
}

walk(ROOT);

if (violations.length) {
  console.error(`docs-check: ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("docs-check: OK");
