# ADR 006: Staging Directory Bloat & Disk Exhaustion (Self-Inflicted DoS)

## Problem

A server starts erroring rapidly; the cooldown prevents duplicate dumps, but
if the link to S3 is slow or down, staging accumulates crash files on disk.
If Flightbox fills the local disk, the HOST application crashes: the
debugging tool has caused a permanent DoS of production.

## Decision

1. **Strict staging quota** — hard limit on staging folder size
   (`FLIGHTBOX_MAX_STAGE_MB`, default 500).
2. **FIFO eviction** — writing a new dump over quota silently deletes the
   oldest staged `.fbox` first.
3. **Disk health check** — before any `writeFileSync` on the trigger path,
   synchronously check free space; below the safety floor (default 5% free,
   i.e. 95% full), disable the agent entirely.

## Implementation (Week 1)

- `src/dump/stage.ts` — quota + FIFO eviction + `fs.statfsSync` health check
  (feature-detected; unknown = healthy, never disable on a probe failure).
- `src/index.ts` — a `DiskFullError` from staging disarms the recorder and
  logs loudly.
- `src/config.ts` — `staging.maxStageMb` / `staging.minDiskFreePct`,
  env-overridable via `FLIGHTBOX_MAX_STAGE_MB`.

## Addendum (crash-loop scenario)

A crash-looping app (config error at boot → uncaught → dump → restart) can
produce dumps faster than any link drains them. Two consequences folded in:

- **`delivered/` shares the quota** — local retention is FIFO-evicted with
  the same limit before each move (`markDeliveredSync`), so neither staging
  nor retention can outgrow the cap.
- With the ADR 010 per-pid dirs, a crash loop creates a NEW pid dir per
  restart; the adoption pass runs before anything else at boot, so all
  prior dumps flow into the single live worker's quota-bound dir rather
  than accumulating unbounded across dirs.
