import { gzipSync } from 'node:zlib';
import { EVENT_TYPE_NAMES, type DecodedEvent } from '../encoder';
import { getAnchor, type ClockAnchor } from '../clock';
import {
  FORMAT_VERSION,
  type Incident,
  type IncidentEvent,
  type IncidentMeta
} from '@flightbox/format';

/** Kept in sync with package.json by scripts/sync-version.mjs (runs inside `pnpm run version`). */
export const FLIGHTBOX_VERSION = '0.0.0';

/** ADR 016: dumps are emergency artifacts — fastest gzip level, not smallest. */
export const DUMP_GZIP_LEVEL = 1;

export interface PreparedIncident {
  fileName: string;
  json: string;
  meta: IncidentMeta;
  eventCount: number;
  windowMs: number;
}

export interface SerializedIncident {
  fileName: string;
  data: Buffer;
  meta: IncidentMeta;
  eventCount: number;
  windowMs: number;
}

let dumpCounter = 0;

export interface SerializeOptions {
  service: string;
  trigger: { type: string; reason?: string };
  events: DecodedEvent[];
  /** ADR 009: panic recovery passes the CRASHED run's anchor, not this boot's. */
  anchor?: ClockAnchor;
}

/**
 * Decoded ring events -> envelope JSON (formatVersion 1). Compression is the
 * caller's business: gzipSync on the crash path, threadpool zlib.gzip for
 * live triggers (ADR 016).
 */
export function buildIncident(opts: SerializeOptions): PreparedIncident {
  const anchor = opts.anchor ?? getAnchor();
  const events: IncidentEvent[] = opts.events.map((e) => ({
    seq: e.header.seq,
    wallMs: anchor.wallMs + Number(e.header.tMonoNs - anchor.monoNs) / 1e6,
    tMonoNs: e.header.tMonoNs.toString(),
    type: EVENT_TYPE_NAMES[e.header.type] ?? `unknown.${e.header.type}`,
    // ADR 004: context-less events are "orphan", never an error.
    requestId: e.header.requestId === 0n ? 'orphan' : e.header.requestId.toString(),
    spanId: e.header.spanId.toString(),
    data: e.payload
  }));

  const first = events[0];
  const last = events[events.length - 1];
  const windowMs = first && last ? last.wallMs - first.wallMs : 0;

  const meta: IncidentMeta = {
    service: opts.service,
    capturedAt: new Date().toISOString(),
    wallAnchor: { wallMs: anchor.wallMs, monoNs: anchor.monoNs.toString() },
    trigger: opts.trigger,
    eventCount: events.length,
    windowMs,
    flightboxVersion: FLIGHTBOX_VERSION
  };
  const incident: Incident = { formatVersion: FORMAT_VERSION, meta, events };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // pid in the name keeps files unique across cluster workers (ADR 010).
  const fileName = `incident-${stamp}-p${process.pid}-${(dumpCounter++).toString(36)}.fbox`;
  return {
    fileName,
    json: JSON.stringify(incident),
    meta,
    eventCount: events.length,
    windowMs
  };
}

/** Synchronous variant — crash path and panic recovery only. */
export function serializeIncident(opts: SerializeOptions): SerializedIncident {
  const prepared = buildIncident(opts);
  return {
    fileName: prepared.fileName,
    data: gzipSync(prepared.json, { level: DUMP_GZIP_LEVEL }),
    meta: prepared.meta,
    eventCount: prepared.eventCount,
    windowMs: prepared.windowMs
  };
}
