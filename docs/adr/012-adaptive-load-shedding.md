# ADR 012: AsyncLocalStorage Performance Degradation — Adaptive Load-Shedding

## Problem

The spec treats ALS context tracking as negligible. In high-throughput,
low-latency services (>10k req/s) the constant creation and GC of ALS
contexts measurably degrades p99 latency (5–15% under heavy load). An
observability agent must never be the thing that pushes a hot service over.

## Decision

A **load-shedding mode**: when event-loop lag exceeds a safe threshold
(default 50ms, `FLIGHTBOX_SHED_LAG_MS`), the agent dynamically disables
per-request instrumentation — no ALS context creation, no request/query
events — and downgrades to vitals and global events only. When lag recovers
(with hysteresis, so the flag doesn't flap), full recording resumes.
Shedding transitions are themselves recorded as timeline events so an
incident shows WHEN visibility degraded and why.

## Implementation

- **Week 1 (this milestone): the switch.** `src/load-shedding.ts` holds a
  process-global flag; `instrumentations/http-server.ts` and
  `instrumentations/pg.ts` check it FIRST and pass straight through to the
  original functions when active — zero context creation, zero recording,
  zero allocation on the shed path.
- **Week 2: the sensor.** The vitals sampler (`monitorEventLoopDelay`,
  100ms, unref'd) flips the flag: shed when p50 lag > threshold, resume when
  it drops below half the threshold (hysteresis), emitting
  `flightbox.shedding` custom events on each transition.

## Consequences

- During shedding an incident file has vitals + global events but a gap in
  request swimlanes — the honest trade; the gap itself is diagnostic signal
  (the viewer can shade shed periods using the transition events).
- The overhead benchmark gate (CI) gets a companion test asserting the shed
  path adds no measurable overhead versus the unpatched baseline.
