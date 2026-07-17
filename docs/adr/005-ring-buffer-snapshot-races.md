# ADR 005: Ring Buffer Lock & Snapshot Race Conditions During Heavy Triggers

## Problem

At 500 req/s, a trigger fires and the agent must copy events out of the
preallocated ring while traffic keeps recording. Locking the buffer blocks
the single-threaded server (latency spike); copying concurrently risks
reading partially overwritten records (corrupt payloads).

## Decision

1. **Zero-lock pointer freeze** — on trigger, do not serialize in place:
   atomically swap a fresh ring buffer in for active writes and keep the old
   one frozen; the frozen bytes can never be overwritten mid-dump.
2. **Double-buffering on trigger** — the swapped-in buffer IS the secondary
   buffer: live telemetry is never blocked or corrupted during the dump.

## Implementation (Week 1)

- `src/recorder.ts` — `Recorder.freezeAndSwap()` returns the frozen ring and
  installs a new one (Buffer.allocUnsafe: no zeroing cost).
- `src/dump/snapshot.ts` — `takeFrozenSnapshot()` decodes only the frozen
  segment.

## Notes

Serialization (gzip) of the frozen segment currently runs synchronously on
the loop: the crash path (uncaughtException, Week 2) REQUIRES a synchronous
serialize+stage, so the sync path must exist anyway. Moving non-crash dumps
to lazy/deferred serialization of the frozen ring is compatible with this
design and can land later without format changes.
