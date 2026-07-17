# Flightbox architecture

The canonical specification is **the Flightbox Bible v2 (Ship Edition)** —
the complete build + deployment spec covering repository structure, the
published package.json, the tsup build pipeline, the dump pipeline
(staging → sinks → recovery), the platform playbook, the zero-dependency S3
client, the viewer, testing, and release engineering.

Reality amendments to the Bible live in [the ADR log](adr/README.md)
(ADRs 004–018 as of Week 1). When code and Bible disagree, the newest ADR
wins.

## Decisions locked (Bible §14 + ADR deltas)

| Decision | Choice | Where |
|---|---|---|
| Package layout | CLI inside `flightbox`; `@flightbox/format` bundled via tsup `noExternal` (source-only workspace package, never published) | §1–3 |
| Build | tsup, dual CJS+ESM (`.cjs`/`.mjs` via outExtension), d.ts, shebang bin | §3 |
| Dump path | staging-first sync write → sinks → boot recovery | §4 |
| Staging safety | quota + FIFO eviction + disk kill-switch; per-pid dirs + orphan adoption; delivered/ shares quota | ADR 006, 010 |
| Crash path | sync serialize always exists; OOM panic path = raw ring dump on preopened fd, converted next boot | ADR 009 |
| Snapshot under load | freeze-and-swap double buffering, zero locks | ADR 005 |
| Ring wrap | strict no-split marker-wrap; VM double-mapping rejected for v1 | ADR 011 |
| Hot path | zero-allocation record (scratch header + vectored ring write); load-shedding switch above lag threshold | ADR 015, 012 |
| Context | ALS born only at HTTP entry, severed at response finish; orphan fallback | ADR 004 |
| ESM | prototype patching for v1 targets; `module.register()` hooks for pure-ESM targets | ADR 013 |
| Threads | main-thread-only by default; coordinator design post-v0.1 | ADR 014 |
| S3 client | hand-rolled SigV4 + fetch; IMDSv2/ECS credential chain; MinIO-tested | §6, ADR 017 |
| Magic link | presigned URL from the developer's own bucket; self-hostable viewer origin; CLI proxies s3:// for air-gapped nets | §4.4, ADR 008 |
| Viewer at scale | **v0.1 shipped:** LOD-clustered canvas + memoized/indexed derivations + parse guards (size/event caps). **Planned (ADR 018):** worker streaming parse → columnar arrays, OffscreenCanvas | ADR 018 |
| Compression | off-loop (threadpool zlib, then worker thread if benchmarks demand) for non-crash dumps | ADR 016 |
| Runtime deps | msgpackr only; Node >= 18; serverless unsupported in v1 | §2, §5 |
