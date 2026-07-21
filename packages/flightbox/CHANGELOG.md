# fboxrec

## 0.3.0

### Minor Changes

- 1652003: `stop()` now removes the module patches instead of leaving them installed as
  no-ops: `http.Server.prototype.emit`, `http`/`https` `request`+`get`, global
  `fetch`, `console.*`, and the `pg` `Client.prototype.query` /
  `Pool.prototype.connect` wrappers are all restored to their original
  references. If other tooling wrapped one of these after Flightbox did, that
  chain is left intact (removing it would strip the other tool's patch too) and
  the buried Flightbox wrapper becomes a pass-through. `start()` after `stop()`
  re-instruments correctly in both cases, without double-patching.

  This matters for test suites and clean shutdown: `stop()` now returns the
  process to its pre-`start()` state.

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
