# fboxrec

## 0.1.0

### Minor Changes

- 6e92d43: Initial release: flight recorder for Node.js servers.

  - Preallocated in-memory ring buffer (no-split wrap) with a zero-allocation
    record path; 29-byte binary event headers + msgpackr payloads
  - Instrumentation for http server/client, pg, and console, correlated per
    request via AsyncLocalStorage
  - Triggers: slow-request (end-hook + in-flight watchdog), uncaught
    exception/rejection with OOM panic escalation, manual `flightbox.trigger()`
    — all with cooldown, freeze-and-swap snapshots, off-loop gzip
  - Crash-safe staging (quota, FIFO eviction, disk kill-switch, cluster-mode
    orphan adoption, boot-time recovery) and an S3/R2 sink with SigV4 signing
    and the IMDSv2/ECS credential chain
  - Vitals sampler driving adaptive load-shedding; redaction fast-path
  - CLI: `flightbox open` (bundled offline viewer) and `flightbox doctor`
