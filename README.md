# Flightbox

**Flight recorder for Node.js servers.** Records the last N seconds of your
server's activity — HTTP requests (Express/Fastify/Koa/`node:http`), `pg`
queries and pool waits, outbound HTTP/fetch, `console.*` output, event-loop
and memory vitals — into a preallocated in-memory ring buffer, and keeps it
only when something breaks.

> *(demo GIF of the scrubber replaying a meltdown goes here — Week 4)*

## Quickstart

```bash
npm install fboxrec
```

```js
require('fboxrec').start();   // or: node -r fboxrec/register server.js
```

When a trigger fires (slow request, uncaught exception, or `flightbox.trigger()`):

```
flightbox: 🔴 incident captured (18.2 KB gz, 41,203 events, 96.1s window)
flightbox:    trigger: manual — checkout latency spike
flightbox:    staged:  .flightbox/staging/pid-27276/incident-2026-07-16T14-05-53.fbox
```

Logs tell you *that* it happened. Flightbox shows you *what everything was
doing* when it did.

## How it works

```
 YOUR SERVER (your infra)                            YOUR BROWSER
┌──────────────────────────────────────┐
│ require('fboxrec').start()           │            viewer.flightbox.dev
│  ├ instruments http / pg / logs      │            (static; renders in-browser,
│  ├ ring buffer (RAM, preallocated)   │             file never uploaded)
│  └ TRIGGER →                         │                    ▲
│     1. sync write → staging dir      │                    │
│     2. upload → YOUR S3/R2 ──────────┼──► incident.fbox ──┘
│     3. print magic link              │
└──────────────────────────────────────┘
     alt: npx fboxrec open incident.fbox   (local viewer, fully offline)
```

Your incident data never touches our servers: drag-and-drop parsing is
in-browser, and magic links fetch browser→your-bucket.

## Status

**v0.1 — all milestones implemented and verified** (90 tests green,
typecheck clean, dual CJS+ESM build, CLI smoke-tested). The recording core
(ring buffer, triggers, staging, sinks) is the mature part; the viewer ships
its LOD canvas and parse guards, with worker/columnar streaming (ADR 018)
deferred until incidents routinely exceed the event-count cap.

- ✅ Week 1 spine: preallocated ring buffer (no-split wrap, property-tested —
  ADR 011), 29-byte encoding + msgpackr, zero-allocation hot path (ADR 015),
  ALS request correlation (ADR 004), http-server + pg instrumentation,
  freeze-and-swap dumps (ADR 005), crash-safe staging (ADRs 006/010), OOM
  panic path (ADR 009), worker-thread guard (ADR 014)
- ✅ Week 2: trigger engine — slow-request + in-flight watchdog, uncaught
  exception with panic escalation; vitals sampler driving adaptive
  load-shedding (ADR 012); console capture; redaction fast-path (ADR 007);
  off-loop gzip compression (ADR 016); http-client instrumentation (ADR 013)
- ✅ Weeks 3–4: viewer — canvas timeline with zoom/pan + LOD (ADR 018),
  swimlanes, scrubber with instant-state, vitals band, log rail; demo app
  with planted bug + loadtest
- ✅ Week 5: S3/R2 sink (SigV4 signer + IMDSv2/ECS credential chain — ADRs
  008/017), `flightbox open` (bundled offline viewer) + `flightbox doctor`,
  overhead benchmark, CI/release workflows + changesets

See [docs/architecture.md](docs/architecture.md) and the
[ADR log](docs/adr/README.md) for every decision and its reasoning.

## Repo layout

| Path | What | Ships as |
|---|---|---|
| `packages/flightbox` | agent + CLI | published to npm as **`fboxrec`** — the only thing users install |
| `packages/format` | `.fbox` contract (types/parse/validate) | bundled into `flightbox`; imported by the viewer |
| `packages/viewer` | React timeline viewer | static site (Cloudflare Pages) + bundled into the CLI |
| `examples/demo-app` | the victim with the planted bug | never ships |

## Development

```bash
pnpm install
pnpm test        # vitest: property-based ring tests, panic recovery, e2e
pnpm typecheck
pnpm build       # tsup: dual CJS+ESM + d.ts + CLI bin
```

MIT
