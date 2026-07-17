# ADR 013: ESM Module Customization Hooks vs. Monkey-Patching

## Problem

In ESM, imports are read-only bindings: rebinding an exported function after
evaluation throws or fails silently. Classic CJS require-cache patching does
not exist for ESM graphs.

## Reality check (what actually breaks, and what doesn't)

Flightbox's current patches mutate **prototype objects**, not import
bindings: `http.Server.prototype.emit` and `pg.Client.prototype.query`.
Object mutation is visible through any module system — `node:http` is a
singleton either way, and `pg` ships as CommonJS, so `import pg from 'pg'`
receives the same (mutated) `module.exports` object via CJS/ESM interop.
The Week 1 instrumentation set therefore works under both `require` and
`import` today, and the integration tests exercise it from ESM (vitest).

What genuinely breaks: wrapping **top-level function exports of pure-ESM
packages** (e.g. a future ESM-only pg, `got`, `undici` helpers imported as
named bindings). Those need interception BEFORE evaluation.

## Decision

1. Prototype-based patching remains the v1 mechanism for the current target
   set (node:http core, pg CJS) — it is load-order-tolerant and zero-config.
2. For pure-ESM targets, Flightbox adopts **module customization hooks**
   (`module.register()` — initialize/resolve/load on the loader thread),
   registered from the existing `fboxrec/register` entrypoint: the
   documented ESM setup (`node --import fboxrec/register`) is ALREADY the
   loader-hook injection point, so users' setup line does not change.
3. Each instrumentation in the registry declares its mechanism
   (`patch` | `loader-hook`) so the two coexist; `flightbox doctor` reports
   which mechanism is active for which module.

## Status

Accepted. Loader-hook infrastructure lands when the first pure-ESM target
instrumentation does (http-client/`undici` work, Week 2–3). No change to
Week 1 behavior.
