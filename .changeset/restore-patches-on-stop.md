---
'fboxrec': minor
---

`stop()` now removes the module patches instead of leaving them installed as
no-ops: `http.Server.prototype.emit`, `http`/`https` `request`+`get`, global
`fetch`, `console.*`, and the `pg` `Client.prototype.query` /
`Pool.prototype.connect` wrappers are all restored to their original
references. If other tooling wrapped one of these after Flightbox did, that
chain is left intact (removing it would strip the other tool's patch too) and
the buried Flightbox wrapper becomes a pass-through. `start()` after `stop()`
re-instruments correctly in both cases, without double-patching.

This matters for test suites and clean shutdown: `stop()` now returns the
process to its pre-`start()` state.
