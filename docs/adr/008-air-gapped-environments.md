# ADR 008: Air-Gapped & Private VPC Environments (The Enterprise Boundary)

## Problem

The magic-link architecture assumes the developer's browser can reach BOTH
the public `viewer.flightbox.dev` AND the bucket holding the `.fbox` file.
In secure corporate environments the bucket sits inside a private VPC with
zero public ingress: even with CORS configured, a browser on the corporate
network cannot fetch from a private bucket into a public origin.

## Decision

1. **Self-hosted viewer origin** — the S3 sink's presign config gains
   `viewerOrigin` (env: `FLIGHTBOX_VIEWER_ORIGIN`, default
   `https://viewer.flightbox.dev`). The printed magic link uses it, so an
   enterprise can deploy the static viewer (same Vite build — it is already
   origin-agnostic via `base: './'`) behind their VPN and get working links.
2. **CLI as remote-file proxy** — `npx fboxrec open s3://bucket/key`
   (and presigned `https://` URLs) downloads server-side using the machine's
   own credentials/network position, then serves the file to the bundled
   local viewer at `localhost:4560/__incident`. The browser only ever talks
   to localhost — works over SSH tunnels and inside air-gapped networks.

## Status

Accepted; lands with the S3 sink + CLI milestone (Week 5). No format or
Week 1 code impact. Affects: `src/dump/sinks/s3.ts` (link construction),
`src/cli/open.ts` (s3:///https source support), `src/config.ts`
(`FLIGHTBOX_VIEWER_ORIGIN`), `docs/sinks.md` (platform playbook entry for
VPC deployments).
