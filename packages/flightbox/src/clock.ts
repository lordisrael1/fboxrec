/**
 * All event timestamps are process.hrtime.bigint() nanoseconds — monotonic,
 * immune to NTP adjustments. Wall-clock time is anchored exactly once when
 * the agent starts; the serializer derives wall times from (mono - anchor).
 */

export interface ClockAnchor {
  wallMs: number;
  monoNs: bigint;
}

let anchor: ClockAnchor | null = null;

export function anchorClock(): ClockAnchor {
  anchor = { wallMs: Date.now(), monoNs: process.hrtime.bigint() };
  return anchor;
}

export function getAnchor(): ClockAnchor {
  if (anchor === null) anchor = anchorClock();
  return anchor;
}

export function nowMono(): bigint {
  return process.hrtime.bigint();
}

export function monoToWallMs(tMonoNs: bigint): number {
  const a = getAnchor();
  return a.wallMs + Number(tMonoNs - a.monoNs) / 1e6;
}
