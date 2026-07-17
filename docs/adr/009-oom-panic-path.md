# ADR 009: Out-Of-Memory (OOM) Crash Recovery — The Panic Path

## Problem

On uncaughtException the agent performs a synchronous dump: copy the ring,
serialize metadata, `zlib.gzipSync()`, write to disk. But if the process is
crashing BECAUSE it ran out of heap, V8 is starved: allocating gzip buffers
or running compression aborts the process with
`FATAL ERROR: Ineffective mark-compacts near heap limit` before the handler
finishes. The crash handler never completes exactly when it matters most.

## Decision

A **Low-Memory/OOM Panic Path** that bypasses compression and decoding
entirely:

1. **Preallocated resources** — at `start()`, while memory is plentiful,
   preopen a file descriptor (`staging/panic-<pid>.fboxpanic`) and
   preallocate the 44-byte panic header buffer.
2. **Raw dump** — on panic, write the panic header (magic, ring pointers,
   clock anchor) followed by the ring's underlying buffer AS-IS via
   `fs.writeSync` on the preopened fd. No gzip, no msgpack decode, no
   envelope building — near-zero allocation.
3. **Boot-time conversion** — the next process's recovery pass parses
   `.fboxpanic` files (pointers + anchor are in the header), decodes and
   re-orders the records, and serializes a normal `.fbox` incident — memory
   is plentiful again by then. Empty placeholder files from clean runs are
   swept; unparseable files are renamed `.corrupt`, never silently deleted.

## Implementation (Week 1: primitive + recovery)

- `src/dump/panic.ts` — `PanicWriter` (arm/writeSync/disarm) +
  `recoverPanicFiles()`.
- `src/ring-buffer.ts` — `rawState` accessor and static `readRecords()`
  shared by live snapshots and panic-file parsing (with corrupt-length
  guards).
- `src/dump/serializer.ts` — accepts an anchor override so recovered events
  get wall-clock times from the CRASHED run's anchor, not the new boot's.

The escalation decision (heap-pressure detection choosing panic path over
gzip path) lands with the uncaughtException trigger in Week 2.
