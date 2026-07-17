# ADR 015: High-Throughput GC Thrashing — Zero-Allocation Serialization

## Problem

The ring is preallocated, but serializing events on the hot path can still
churn V8's young generation: header buffers, msgpack outputs, and slices
allocated per event become GC pressure at thousands of events/second —
causing exactly the latency spikes Flightbox exists to observe.

## Decision

1. **Vectored ring writes with a reusable scratch header (implemented).**
   `record()` no longer allocates a per-event record buffer: the 29-byte
   header is written into one module-lifetime scratch buffer and the ring
   copies header + msgpack body directly into preallocated memory
   (`RingBuffer.write(header, body)`). msgpackr's `pack()` already reuses an
   internal buffer and returns a subarray — safe because the ring copies out
   immediately. Steady-state allocations per event: the payload object
   literal, nothing else.
2. **Dynamic sampling under pressure** — already decided and implemented as
   the ADR 012 load-shedding switch: above the lag threshold, non-essential
   instrumentation is bypassed entirely.
3. **Payload object pooling — deferred, benchmark-gated.** Pooling the small
   payload literals adds lifetime/aliasing bugs (a pooled object reused
   while msgpackr reads it = corrupted incident). Young-gen scavenges of
   short-lived literals are cheap; we only take this complexity if the CI
   overhead gate (Week 5) shows the literals matter.

## Status

Items 1–2 implemented (Week 1): `src/recorder.ts`, `src/ring-buffer.ts`,
`src/encoder.ts` (`encodeHeaderInto`), `src/load-shedding.ts`. Item 3
deferred pending benchmark evidence.
