# ADR 016: Trigger-Induced Event Loop Starvation — Off-Loop Compression

## Problem

A trigger fires while the server is already struggling. `zlib.gzipSync` over
a large snapshot is CPU-heavy; running it on the main thread blocks the
event loop for seconds, converting a degradation into a self-inflicted
outage for every concurrent user.

## Decision — phased, because the sync path can never be deleted

The crash path (uncaughtException, ADR 009) REQUIRES synchronous
serialize+stage — the process is dying and there is no later. So sync
serialization stays; what changes is what the NON-crash triggers use:

1. **Async zlib on the libuv threadpool (Week 2, with the trigger engine).**
   `zlib.gzip()` (callback form) already runs compression off the main
   thread on libuv workers — no worker_threads plumbing needed. Combined
   with the ADR 005 freeze-and-swap (the frozen ring is immutable, live
   traffic records into the fresh one), non-crash dumps become: freeze
   (instant) → decode+stringify (main loop, bounded) → gzip (threadpool) →
   async write. Compression, the dominant cost, leaves the loop.
   Also: gzip level 1 for dumps — ~5x less CPU for a few % size, the right
   trade for an emergency artifact.
2. **Full worker-thread dump pipeline (benchmark-gated).** If the CI
   overhead gate shows decode+stringify of a full 64MB ring still stalls the
   loop, hand the frozen ring's ArrayBuffer (transferable, zero-copy) to a
   spawned Worker that decodes, envelopes, gzips, and writes — the main
   thread's cost drops to the freeze itself. This is additive; the .fbox
   format and staging protocol don't change.

## Interim honesty (Week 1)

Manual triggers currently serialize synchronously on the loop. Acceptable
for the milestone (dev-invoked, small test buffers), noted here so it cannot
silently ship in v0.1: item 1 lands with the Week 2 trigger engine, which is
what makes triggers fire under real load in the first place.
