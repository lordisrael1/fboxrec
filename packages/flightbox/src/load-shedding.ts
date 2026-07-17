/**
 * ADR 012 — adaptive load-shedding switch. When active, per-request
 * instrumentation passes straight through: no ALS context, no events, no
 * allocation. The flag is flipped by the vitals sampler (Week 2) when
 * event-loop lag crosses the configured threshold, with hysteresis.
 *
 * Kept as a bare module-level boolean: the check sits on the hottest path
 * in the agent and must cost a single property read.
 */

let active = false;

export function isShedding(): boolean {
  return active;
}

export function setShedding(on: boolean): void {
  active = on;
}
