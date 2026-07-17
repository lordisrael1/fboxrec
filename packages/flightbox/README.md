# fboxrec — Flightbox

Flight recorder for Node.js servers. Records the last N seconds of your
server's activity — HTTP in/out, `pg`, `console.*`, vitals (the full list
below) — into a preallocated in-memory ring buffer; keeps it only when
something breaks.

```bash
npm install fboxrec
```

```js
// One line at the top of your entrypoint:
require('fboxrec').start();

// Or zero code changes:
//   node -r fboxrec/register server.js          (CJS)
//   node --import fboxrec/register server.js    (ESM)
```

## What gets recorded

- HTTP server requests (method, path, status, duration) — Express, Fastify,
  Koa, bare `node:http`
- Outbound HTTP calls, correlated to the request that made them
- `pg` queries (text truncated at 2KB, parameter *shapes* — never values)
  and pool wait times
- `console.*` output, event-loop lag and memory vitals
- Custom events: `flightbox.addEvent('cache.miss', { key })`

Everything is correlated by request via AsyncLocalStorage, timestamped with
the monotonic clock, and held in a fixed 64MB ring (configurable) — the
recorded window is a consequence of memory and traffic, not a setting.

## When something breaks

Triggers snapshot the ring into a gzipped `.fbox` incident file:

- **slow request** — measured at request end, plus an in-flight watchdog
  that catches requests that will never finish
- **uncaught exception / unhandled rejection**, with an OOM panic path that
  survives heap exhaustion
- **heap pressure** and **event-loop stall** thresholds
- **manual** — `flightbox.trigger('reason')`

One storm = one file (60s cooldown). Incidents are staged crash-safely on
local disk first, then delivered to your sinks (S3/R2/MinIO via built-in
SigV4 — no AWS SDK; or disk/http). Your data never touches anyone else's
servers.

Staging is quota-bound (default 500MB, FIFO eviction), oversized dumps are
refused outright, and a disk-space floor disables the agent before it can
push a disk to full. Note the quota is **per process**: in a cluster of N
workers the local ceiling is roughly N × the quota (each worker stages into
its own dir), plus the `delivered/` retention bucket. Size the quota with
your worker count in mind — a single process cannot fill the disk, but the
guarantee is per-process, not host-wide (a host-wide coordinator is
post-v0.1, ADR 014).

## Viewing an incident

```bash
npx fboxrec open incident.fbox        # bundled offline viewer on localhost
npx fboxrec open s3://bucket/key      # downloads with YOUR credentials
npx fboxrec doctor                    # verifies config, creds, connectivity
```

## Configuration

```js
require('fboxrec').start({
  service: 'checkout-api',
  bufferMb: 64,
  dir: '.flightbox',
  triggers: { slowRequestMs: 5000, cooldownMs: 60000 },
  sinks: [{ type: 's3', bucket: 'acme-incidents', prefix: 'prod/' }]
});
```

Or env vars only: `FLIGHTBOX_BUFFER_MB`, `FLIGHTBOX_DIR`,
`FLIGHTBOX_SERVICE`, `FLIGHTBOX_TRIGGER_SLOW_MS`, `FLIGHTBOX_MAX_STAGE_MB`,
`FLIGHTBOX_S3_BUCKET` (+ `FLIGHTBOX_S3_REGION` / `FLIGHTBOX_S3_ENDPOINT`).

Requires Node >= 18. One runtime dependency (msgpackr).

MIT
