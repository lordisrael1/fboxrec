# ADR 010: PM2 / Node.js Cluster Mode Isolation

## Problem

The staging directory was a single shared path (`./.flightbox/staging`).
Apps running in cluster mode (PM2, native `cluster`) boot several workers
simultaneously; all would target the same folder, and during boot-time
recovery all would try to read, upload, and delete the same crashed files at
once — race conditions, file locking errors (especially on Windows), and
corrupted uploads.

## Decision

1. **Process-isolated staging** — each worker writes to its own
   subdirectory: `./.flightbox/staging/pid-<pid>/`. Incident file names also
   embed the pid, so files stay unique even after adoption.
2. **Atomic orphan adoption** — per-PID dirs alone would strand a crashed
   worker's files (its replacement has a NEW pid). On boot, each worker scans
   sibling `pid-*` dirs, skips live processes (`process.kill(pid, 0)`
   liveness probe), and claims dead ones via atomic `fs.renameSync` — the
   rename succeeds for exactly one claimant; losers get ENOENT and move on.
   Claimed files are absorbed into the claimant's own staging dir and flow
   through the normal recovery/delivery pass.

## Trade-offs / notes

- The staging quota (ADR 006) is enforced **per process**; with N workers
  the worst-case footprint is N x FLIGHTBOX_MAX_STAGE_MB. Documented in
  `docs/sinks.md` when it lands.
- PID reuse by the OS can make a dead worker's dir look alive; the dir is
  then simply adopted on a later boot. Accepted as benign.

## Implementation (Week 1)

- `src/dump/stage.ts` — `Staging.stagingDir` is `staging/pid-<pid>/`;
  `claimOrphanedSync()` implements the adoption pass, invoked from
  `recoverOnBoot()` before anything else.
- `src/dump/serializer.ts` — pid embedded in incident file names.
- Panic files (ADR 009) live inside the pid dir and are recovered after
  adoption, so a dead worker's raw panic dump is converted by whichever
  worker adopts it.
