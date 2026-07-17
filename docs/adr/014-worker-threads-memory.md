# ADR 014: Multi-Threaded Memory Multiplication (worker_threads)

## Problem

If the host app uses `worker_threads` (or a pool manager like Piscina) and
Flightbox initializes in every thread, each worker allocates its own 64MB
ring. On an 8-core box that silently hijacks 512MB for idle trace buffers —
enough to starve the host and cause the very OOM Flightbox exists to debug.

## Decision

1. **Week 1 guard (implemented): main-thread-only by default.** `start()`
   checks `worker_threads.isMainThread`; in a worker it logs once and
   becomes a no-op. Multiplication is impossible by default. An explicit
   `allowWorkerThreads: true` opt-in exists for users who accept the cost
   (e.g. one dedicated heavy worker) — the log message states the per-thread
   price.
2. **Full solution (scheduled): single-coordinator recording.** Worker
   threads get a thin producer that streams encoded event frames over a
   `MessagePort` (transferable, no copy) to the main thread's ring — one
   64MB pool total. A `SharedArrayBuffer` multi-producer ring (Atomics-based
   claim/commit) is the zero-hop alternative if MessagePort throughput
   proves limiting; frame format (ADR 011) is identical either way, so the
   choice is swappable behind the Recorder interface.

## Status

Guard implemented (Week 1): `src/index.ts` + `allowWorkerThreads` in
`src/config.ts`. Coordinator design scheduled post-v0.1 — it must not slip
into the demo-critical path.
