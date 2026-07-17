# ADR 007: Log Scrubbing & Dynamic Regex Performance Tax

## Problem

Redaction (passwords, PANs, auth headers) must run over log messages and
query text. Heavy regexes over large payloads on the hot path (every single
log/query) destroy CPU throughput.

## Decision

1. **Fast-path string scanning** — a cheap case-insensitive
   `String.prototype.includes()` sweep for sensitive key markers
   (`token`, `password`, `secret`, `authorization`, ...) runs first.
2. **Targeted escalation** — only on a fast-path hit does the heavier,
   targeted regex logic (JWT pattern, Luhn-checked PANs, key-name masking)
   execute. No hit = zero regex cost.

## Status

Accepted; lands with `src/redaction.ts` in the Week 2 milestone (console
capture is what first puts free-form text on the hot path). Week 1 already
conforms by construction: HTTP events carry method/path/status only, and pg
events carry parameter SHAPES (`['string','number']`), never values —
see `paramShapes()` in `src/instrumentations/pg.ts`.
