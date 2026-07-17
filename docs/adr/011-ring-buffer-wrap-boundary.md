# ADR 011: Ring Buffer Fragmentation & Wrap-Around Splitting

## Problem

The ring stores variable-length records in one preallocated Buffer. A write
near the end frequently doesn't fit the remaining tail. Splitting a record
across the boundary makes reads complex and corruption-prone; padding with a
SKIP marker wastes tail space. The wrap boundary behavior must be strict and
explicit, not incidental.

## Options considered

1. **Split records across the boundary** — rejected: read-side reassembly is
   the classic source of torn-record corruption, and the panic path (ADR 009)
   dumps the raw buffer, so frames must be contiguous to survive recovery.
2. **Virtual-memory double mapping** ("magic ring buffer": map the same
   physical pages twice back-to-back, write across the seam with plain
   pointers) — the ideal CPU-side answer, but Node.js cannot mmap aliased
   pages without a **native addon**. That breaks two locked §14 decisions at
   once: exactly ONE runtime dependency (msgpackr) and pure-JS portability.
   An observability agent that needs node-gyp at install time is one nobody
   installs. **Rejected for v1.**
3. **Strict no-split marker-wrap** — a record that doesn't fit the tail is
   written ENTIRELY at offset 0; if >= 4 bytes remain at the tail, an
   explicit WRAP marker (0xFFFFFFFF length prefix) is written; a tail gap
   < 4 bytes is an implicit wrap. **Chosen.**

## Why the waste is acceptable (quantified)

Payloads are truncated at capture (query 2KB, log 1KB, path 512B), so the
largest record is ~2.1KB including header. Worst-case tail waste is one
max-record per lap: 2.1KB per 64MB, ~0.003% of capacity. Fragmentation does
not accumulate — the tail gap is reclaimed on the very next lap.

## Consequences

- Reader logic is a single normalize step (`gap < 4 || marker -> pos = 0`),
  shared by live snapshots and panic-file recovery (`RingBuffer.readRecords`).
- The no-split invariant is what makes the raw panic dump (ADR 009)
  parseable by a later process.
- Property-based tests (fast-check) assert snapshot integrity across
  arbitrary write sequences and wrap positions.
- If profiling ever shows the marker path hot, a double-mapped native
  accelerator can ship as an OPTIONAL package (`@flightbox/native-ring`)
  without changing record framing; the pure-JS ring remains the default.
