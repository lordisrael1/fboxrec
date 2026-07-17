import type { Incident, IncidentEvent } from '@flightbox/format';

/**
 * Turns the flat event list into the timeline model: request swimlanes with
 * nested query/client spans (paired by requestId / spanId), vitals series,
 * log lines, trigger markers. Lane assignment is classic interval
 * scheduling — first free lane wins.
 */

export interface Span {
  kind: 'request' | 'query' | 'client' | 'poolwait';
  requestId: string;
  spanId: string;
  label: string;
  startMs: number;
  endMs: number;
  /** True when the end event never arrived (hung/in-flight at capture). */
  open: boolean;
  status?: number;
  error?: string;
  aborted?: boolean;
  lane: number;
  depth: number;
  startEvent: IncidentEvent;
  endEvent?: IncidentEvent;
}

export interface VitalsPoint {
  t: number;
  lagMs: number;
  maxLagMs: number;
  heapUsed: number;
  rss: number;
}

export interface LogLine {
  t: number;
  seq: number;
  level: string;
  msg: string;
  requestId: string;
}

export interface Marker {
  t: number;
  triggerType: string;
  reason?: string;
  suppressed: boolean;
  event: IncidentEvent;
}

export interface Model {
  spans: Span[];
  laneCount: number;
  vitals: VitalsPoint[];
  logs: LogLine[];
  markers: Marker[];
  t0: number;
  t1: number;
  incident: Incident;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function buildModel(incident: Incident): Model {
  const events = incident.events;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const e of events) {
    if (e.wallMs < t0) t0 = e.wallMs;
    if (e.wallMs > t1) t1 = e.wallMs;
  }
  if (!Number.isFinite(t0)) {
    t0 = 0;
    t1 = 1;
  }
  if (t1 - t0 < 1) t1 = t0 + 1;

  const requests = new Map<string, Span>();
  const subByspan = new Map<string, Span>();
  const spans: Span[] = [];
  const vitals: VitalsPoint[] = [];
  const logs: LogLine[] = [];
  const markers: Marker[] = [];

  for (const e of events) {
    switch (e.type) {
      case 'http.server.start': {
        const span: Span = {
          kind: 'request',
          requestId: e.requestId,
          spanId: e.spanId,
          label: `${str(e.data.method, 'GET')} ${str(e.data.path, '/')}`,
          startMs: e.wallMs,
          endMs: t1,
          open: true,
          lane: 0,
          depth: 0,
          startEvent: e
        };
        requests.set(e.requestId, span);
        spans.push(span);
        break;
      }
      case 'http.server.end': {
        const span = requests.get(e.requestId);
        if (span) {
          span.endMs = e.wallMs;
          span.open = false;
          span.status = num(e.data.status);
          span.aborted = e.data.aborted === true;
          span.endEvent = e;
        }
        break;
      }
      case 'pg.query.start':
      case 'http.client.start': {
        const kind = e.type === 'pg.query.start' ? 'query' : 'client';
        const label =
          kind === 'query'
            ? str(e.data.text, 'query').slice(0, 120)
            : `${str(e.data.method, 'GET')} ${str(e.data.host)}${str(e.data.path)}`.slice(0, 120);
        const span: Span = {
          kind,
          requestId: e.requestId,
          spanId: e.spanId,
          label,
          startMs: e.wallMs,
          endMs: t1,
          open: true,
          lane: 0,
          depth: 1,
          startEvent: e
        };
        subByspan.set(e.spanId, span);
        spans.push(span);
        break;
      }
      case 'pg.query.end':
      case 'http.client.end': {
        const span = subByspan.get(e.spanId);
        if (span) {
          span.endMs = e.wallMs;
          span.open = false;
          span.status = num(e.data.status);
          span.error = typeof e.data.error === 'string' ? e.data.error : undefined;
          span.endEvent = e;
        }
        break;
      }
      case 'pg.pool.wait': {
        const waitMs = num(e.data.waitMs) ?? 0;
        if (waitMs > 0.5) {
          spans.push({
            kind: 'poolwait',
            requestId: e.requestId,
            spanId: e.spanId,
            label: `pool wait ${waitMs.toFixed(0)}ms`,
            startMs: e.wallMs - waitMs,
            endMs: e.wallMs,
            open: false,
            lane: 0,
            depth: 1,
            startEvent: e
          });
        }
        break;
      }
      case 'vitals':
        vitals.push({
          t: e.wallMs,
          lagMs: num(e.data.lagMs) ?? 0,
          maxLagMs: num(e.data.maxLagMs) ?? 0,
          heapUsed: num(e.data.heapUsed) ?? 0,
          rss: num(e.data.rss) ?? 0
        });
        break;
      case 'log':
        logs.push({
          t: e.wallMs,
          seq: e.seq,
          level: str(e.data.level, 'log'),
          msg: str(e.data.msg),
          requestId: e.requestId
        });
        break;
      case 'trigger':
        markers.push({
          t: e.wallMs,
          triggerType: str(e.data.triggerType, 'trigger'),
          reason: typeof e.data.reason === 'string' ? e.data.reason : undefined,
          suppressed: e.data.suppressed === true,
          event: e
        });
        break;
      default:
        break;
    }
  }

  // Interval-scheduling lane assignment for request swimlanes.
  const reqSpans = spans.filter((s) => s.kind === 'request').sort((a, b) => a.startMs - b.startMs);
  const laneEnds: number[] = [];
  for (const span of reqSpans) {
    let lane = laneEnds.findIndex((end) => end <= span.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(span.endMs);
    } else {
      laneEnds[lane] = span.endMs;
    }
    span.lane = lane;
  }

  // Children ride in their parent request's lane; orphans get lanes below.
  const orphanLaneEnds: number[] = [];
  const orphanBase = laneEnds.length;
  for (const span of spans) {
    if (span.kind === 'request') continue;
    const parent = requests.get(span.requestId);
    if (parent && span.requestId !== 'orphan') {
      span.lane = parent.lane;
    } else {
      let lane = orphanLaneEnds.findIndex((end) => end <= span.startMs);
      if (lane === -1) {
        lane = orphanLaneEnds.length;
        orphanLaneEnds.push(span.endMs);
      } else {
        orphanLaneEnds[lane] = span.endMs;
      }
      span.lane = orphanBase + lane;
      span.depth = 0;
    }
  }

  return {
    spans,
    laneCount: Math.max(1, orphanBase + orphanLaneEnds.length),
    vitals,
    logs,
    markers,
    t0,
    t1,
    incident
  };
}
