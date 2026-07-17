/** Version of the .fbox envelope this code reads and writes. */
export const FORMAT_VERSION = 1;

/**
 * Well-known event type names. The wire format inside the agent's ring buffer
 * uses numeric codes; the .fbox envelope always carries these string names so
 * incident files remain readable forever, independent of agent internals.
 */
export type EventTypeName =
  | 'http.server.start'
  | 'http.server.end'
  | 'http.client.start'
  | 'http.client.end'
  | 'pg.query.start'
  | 'pg.query.end'
  | 'pg.pool.wait'
  | 'log'
  | 'vitals'
  | 'trigger'
  | 'custom';

export interface IncidentEvent {
  /** Monotonic sequence number assigned at record time. */
  seq: number;
  /** Wall-clock milliseconds (epoch), derived from the monotonic clock + anchor. */
  wallMs: number;
  /** Raw monotonic nanoseconds as a decimal string (bigint-safe). */
  tMonoNs: string;
  /** Event type name; unknown numeric codes serialize as "unknown.<code>". */
  type: EventTypeName | string;
  /**
   * Request correlation id as a decimal string. Events recorded outside any
   * active request context are tagged "orphan" (ADR 004) — never an error.
   */
  requestId: string;
  /** Span id as a decimal string; "0" = not part of a span pair. */
  spanId: string;
  /** Type-specific payload. Already truncated/redacted at capture time. */
  data: Record<string, unknown>;
}

export interface WallAnchor {
  /** Date.now() at the moment the agent started. */
  wallMs: number;
  /** process.hrtime.bigint() at the same moment, as a decimal string. */
  monoNs: string;
}

export interface TriggerInfo {
  type: string;
  reason?: string;
}

export interface IncidentMeta {
  service: string;
  /** ISO timestamp of when the dump was taken. */
  capturedAt: string;
  wallAnchor: WallAnchor;
  trigger: TriggerInfo;
  eventCount: number;
  /** Time span covered by the captured events, in milliseconds. */
  windowMs: number;
  flightboxVersion: string;
}

export interface Incident {
  formatVersion: number;
  meta: IncidentMeta;
  events: IncidentEvent[];
}
