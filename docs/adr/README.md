# Architecture Decision Records

Amendments to [the Flightbox Bible v2](../architecture.md), added when reality
disagrees with the spec. ADRs 001–003 are reserved for the Bible's own locked
decisions (§14); numbered records start where the spec left off.

| ADR | Title | Status |
|---|---|---|
| [004](004-als-context-leaks.md) | AsyncLocalStorage context leaks & performance | **Implemented** (Week 1) |
| [005](005-ring-buffer-snapshot-races.md) | Ring buffer snapshot races under heavy triggers | **Implemented** (Week 1) |
| [006](006-staging-disk-exhaustion.md) | Staging bloat & disk exhaustion (self-inflicted DoS) | **Implemented** (Week 1) |
| [007](007-redaction-performance-tax.md) | Redaction regex performance tax | **Implemented** (Week 2) |
| [008](008-air-gapped-environments.md) | Air-gapped & private VPC environments | **Implemented** (Week 5) |
| [009](009-oom-panic-path.md) | OOM crash recovery: the panic path | **Implemented** (Weeks 1–2) |
| [010](010-cluster-mode-isolation.md) | PM2 / cluster mode staging isolation | **Implemented** (Week 1) |
| [011](011-ring-buffer-wrap-boundary.md) | Ring wrap boundary: no-split marker-wrap; double-mapping rejected for v1 | **Implemented** (Week 1) |
| [012](012-adaptive-load-shedding.md) | ALS overhead: adaptive load-shedding mode | **Implemented** (Weeks 1–2) — vitals lag sensor drives the switch |
| [013](013-esm-module-hooks.md) | ESM: prototype patching holds for v1 targets; module.register() hooks for pure-ESM | **Implemented** (Weeks 2–3) — patching path; `module.register()` post-v0.1 |
| [014](014-worker-threads-memory.md) | worker_threads memory multiplication | **Main-thread guard implemented** (Week 1); coordinator post-v0.1 |
| [015](015-zero-allocation-hot-path.md) | GC thrashing: zero-allocation record path | **Implemented** (Week 1); payload pooling benchmark-gated |
| [016](016-off-loop-compression.md) | Off-loop compression for non-crash dumps | **Implemented** (Week 2) |
| [017](017-aws-credential-chain.md) | S3 sink: IMDSv2/ECS dynamic credential chain | **Implemented** (Week 5) |
| [018](018-viewer-streaming-lod.md) | Viewer: streaming worker parse + LOD canvas | **Implemented** (Weeks 3–4) |
