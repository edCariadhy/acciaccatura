---
type: decision
title: Threaded Replies for Annotations
status: accepted
date: 2026-09-16
---

# Threaded Replies for Annotations

## Context and Problem

Currently, an annotation is a single message. If an agent or human needs to respond to it (e.g. to say a rule is broken or to ask for clarification on the annotation itself), they would have to create a separate, unlinked annotation nearby. This leads to clutter and loss of the conversational context.

The roadmap identified the need for a reply capability:
> Reply capability: a note can only be resolved or deleted today, not answered in place — no way for the other writer (human or agent) to leave a response without opening a second, unrelated note. Real scope: threading plus a resolved-per-reply state means new store schema fields, and the store schema freezes first per standards/stable-contracts.md — needs a decision record before it's built, not just an implementation.

## Decision

We will add a simple, single-level threading capability to annotations.
We are extending the `Annotation` interface in the `core` package with a `replies` array of `Reply` objects.

```ts
export interface Reply {
  id: string;
  body: string;
  provenance: Provenance;
  author?: string;
  createdAt: string;
}
```

An MCP tool `reply_annotation` will be added to the agent's MCP surface.
A command `acciaccatura.replyAnnotation` will be added to the human extension interface.

### Why not fully nested threads?
Single-level threading (replies to the root annotation) keeps the data model simple and limits context bloat. Deep trees are unnecessary for working notes about code.

### Backward Compatibility
- Old annotations without a `replies` array remain valid. The code uses `existing.replies ?? []`.
- Old agents without the `reply_annotation` tool will just read annotations as before. If they see replies, they can read them but cannot reply.

## Consequences

- Annotations can grow larger, which costs context window. However, replies provide much needed density of context.
- Agents and humans can converse about a specific note before resolving it.
