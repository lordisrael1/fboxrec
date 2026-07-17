# ADR 018: Frontend Browser Collapse — Streaming Parse & LOD Rendering

## Problem

A severe incident can be 40MB gzipped / 250MB of raw JSON with 100k+
events. `JSON.parse` of that on the React thread freezes the tab (or OOMs
it), and drawing every span each frame chokes rendering — pan/zoom becomes
unusable. The viewer must stay responsive at exactly the incident sizes
that matter most.

## Decision

1. **Parse off the UI thread.** Loading (all three paths: drag-drop, `?src=`,
   CLI-injected) runs in a Web Worker: DecompressionStream → chunked parse →
   TYPED COLUMNAR ARRAYS (Float64Array times, Uint32Array ids/type codes,
   string tables for paths/queries), transferred to the UI thread as
   transferables (zero copy). The UI thread never holds 250MB of JS objects;
   a progress bar streams in while parsing. The .fbox envelope stays
   line-oriented-friendly (events array of flat objects) so a chunked parser
   doesn't need a full-document DOM.
2. **Level-of-detail rendering.** The worker builds a hierarchical time
   index (bucket tree). At each zoom level the canvas draws AT MOST ~2 marks
   per pixel column: events smaller than a pixel are merged into density
   clusters (count + max-duration encoded in the mark). Zooming in splits
   clusters into real spans. Target: <16ms per frame at 100k+ events,
   enforced by a Playwright perf test on a synthetic 100k-event fixture.
3. **OffscreenCanvas where available** (render in the worker, bitmap to the
   main thread), plain canvas fallback for Safari — the LOD index is the
   real win and works on both.

## Consequences

- `@flightbox/format` gains a streaming/columnar parse entry
  (`parseIncidentColumnar`) alongside the simple `parseIncident` (which
  remains for small files, tests, and the CLI).
- The scrubber's "state at this instant" panel reads from the columnar
  index (binary search on the time array) — faster than the object model it
  replaces.

## Status

**Partially implemented (v0.1).** Shipped: the LOD-clustered canvas
(sub-pixel spans merge into density blocks), memoized/indexed model
derivations (scrubber histogram, instant-state, log-rail binary search),
and hard parse-time guards — decompressed-size and event-count caps so an
untrusted `.fbox` cannot freeze the tab.

**Deferred post-v0.1:** the pieces that assume a much larger working set —
worker-thread streaming parse, the columnar `@flightbox/format` entry, and
OffscreenCanvas rendering. The current viewer parses on the main thread
(`arrayBuffer → gunzip → JSON.parse → model`), which is fine within the
event-count cap; these upgrades matter only once incidents routinely exceed
it. The `Model` shape is deliberately the object graph today, not the
columnar arrays this ADR envisions.
