# fboxrec

## 0.2.0

### Minor Changes

- Reliability, security, and accessibility hardening (second audit round).

  - Recorder/staging: hard staging quota (oversized dumps refused), fsync
    durability on stage, per-event payload cap, u64 counter wraparound.
  - Triggers: unhandledRejection rethrows only when Flightbox is the sole
    listener; crash dumps bypass the routine cooldown; memory-pressure dumps
    swap in a small emergency ring.
  - Instrumentation: bounded scrub-then-cap on the hot path; restored host
    error semantics for http-client and pg; allowlisted request headers;
    the manual dump endpoint is GET-only, exact-path, header-token-only, with
    a scrubbed/capped reason.
  - Sinks: async I/O, 30s fetch timeouts, in-process delivery retry (no longer
    restart-only), per-sink credential resolution (no cross-sink cache
    bleed), disk-sink quota, 24h default presign lifetime.
  - CLI `open`: DNS-rebind guard (Host check) + unguessable incident path;
    download timeout and size cap.
  - Viewer/format: gzip-bomb and event-count parse guards, error boundary,
    NaN-safe formatting, keyboard navigation + ARIA + focus styles, responsive
    layout, memoized/indexed derivations, https-only remote source with a
    confirmation step.
  - Config: sink validation; `doctor` warns it mutates the bucket.

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
