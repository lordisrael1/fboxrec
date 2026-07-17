/** time <-> px mapping, zoom-around-cursor, nice tick generation. */

export interface View {
  start: number;
  end: number;
}

export interface Bounds {
  t0: number;
  t1: number;
}

const MIN_SPAN_MS = 0.5;

export function xOf(t: number, view: View, width: number): number {
  return ((t - view.start) / (view.end - view.start)) * width;
}

export function tOf(x: number, view: View, width: number): number {
  return view.start + (x / width) * (view.end - view.start);
}

export function clampView(view: View, bounds: Bounds): View {
  let span = Math.max(MIN_SPAN_MS, Math.min(view.end - view.start, bounds.t1 - bounds.t0));
  let start = view.start;
  if (start < bounds.t0) start = bounds.t0;
  if (start + span > bounds.t1) start = bounds.t1 - span;
  return { start, end: start + span };
}

/** Zoom keeping the time under the cursor fixed. factor < 1 zooms in. */
export function zoomAround(view: View, tFocus: number, factor: number, bounds: Bounds): View {
  const span = (view.end - view.start) * factor;
  const frac = (tFocus - view.start) / (view.end - view.start);
  return clampView({ start: tFocus - frac * span, end: tFocus + (1 - frac) * span }, bounds);
}

export function pan(view: View, dtMs: number, bounds: Bounds): View {
  return clampView({ start: view.start + dtMs, end: view.end + dtMs }, bounds);
}

export interface Tick {
  t: number;
  label: string;
}

function niceStep(rawMs: number): number {
  const pow = 10 ** Math.floor(Math.log10(rawMs));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= rawMs) return m * pow;
  }
  return 10 * pow;
}

export function niceTicks(view: View, width: number): Tick[] {
  const span = view.end - view.start;
  if (span <= 0 || width <= 0) return [];
  const step = niceStep(span / Math.max(1, width / 110));
  const ticks: Tick[] = [];
  let t = Math.ceil(view.start / step) * step;
  for (; t <= view.end; t += step) {
    ticks.push({ t, label: formatTime(t, step) });
  }
  return ticks;
}

export function formatTime(t: number, stepMs: number): string {
  // NaN/Infinity would make toISOString THROW mid-render (audit H2).
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const hms = d.toISOString().slice(11, 19);
  if (stepMs >= 1000) return hms;
  return `${hms}.${d.toISOString().slice(20, 23)}`;
}

export function formatDur(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
