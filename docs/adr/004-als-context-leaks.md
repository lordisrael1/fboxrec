# ADR 004: AsyncLocalStorage (ALS) Context Leaks & Performance Degradation

## Problem

Flightbox relies on AsyncLocalStorage to associate logs, HTTP client fetches,
and Postgres queries with a parent requestId. In highly concurrent apps,
nested callbacks or poorly written third-party libraries (custom pools,
legacy event emitters) can drop the async context; indefinitely queued
microtasks can keep the storage reference alive and block GC — a slow,
insidious memory leak. ALS is fast in Node 18+, but not free.

## Decision

1. **Strict boundary isolation** — a context is created ONLY at the HTTP
   request entry point, and the requestId reference is aggressively nullified
   when the response finishes emitting.
2. **Safe fallbacks** — an event recorded outside an active context never
   throws; it is tagged `requestId: "orphan"` and recording continues.

## Implementation (Week 1)

- `src/instrumentations/http-server.ts` — the only place a context is born;
  `res.once('finish')` sets `ctx.requestId = 0n`.
- `src/dump/serializer.ts` — requestId `0` serializes as `"orphan"` in .fbox.
- `src/instrumentations/pg.ts` — captures the requestId once at query start
  and stamps it explicitly on both start/end events, so span pairing survives
  the boundary nullification.
