import { pack, unpack } from 'msgpackr';

/**
 * Binary event encoding for the ring buffer: a fixed 29-byte header followed
 * by a msgpackr-packed payload.
 *
 *   offset  size  field
 *   0       4     seq        (u32 LE, wraps)
 *   4       8     tMonoNs    (u64 LE)
 *   12      1     type       (u8)
 *   13      8     requestId  (u64 LE, 0 = none)
 *   21      8     spanId     (u64 LE, 0 = none)
 *   29      ...   msgpackr payload
 */

export const HEADER_SIZE = 29;

/** Numeric wire codes. The .fbox envelope maps these to string names. */
export enum EventType {
  HttpServerStart = 1,
  HttpServerEnd = 2,
  HttpClientStart = 3,
  HttpClientEnd = 4,
  PgQueryStart = 5,
  PgQueryEnd = 6,
  PgPoolWait = 7,
  Log = 8,
  Vitals = 9,
  Trigger = 10,
  Custom = 11
}

export const EVENT_TYPE_NAMES: Record<number, string> = {
  [EventType.HttpServerStart]: 'http.server.start',
  [EventType.HttpServerEnd]: 'http.server.end',
  [EventType.HttpClientStart]: 'http.client.start',
  [EventType.HttpClientEnd]: 'http.client.end',
  [EventType.PgQueryStart]: 'pg.query.start',
  [EventType.PgQueryEnd]: 'pg.query.end',
  [EventType.PgPoolWait]: 'pg.pool.wait',
  [EventType.Log]: 'log',
  [EventType.Vitals]: 'vitals',
  [EventType.Trigger]: 'trigger',
  [EventType.Custom]: 'custom'
};

/** Truncation limits applied at capture time — the hot path never carries big blobs. */
export const LIMITS = {
  path: 512,
  query: 2048,
  log: 1024
} as const;

export function truncate(s: string, max: number): string;
export function truncate(s: string | undefined | null, max: number): string | undefined;
export function truncate(s: string | undefined | null, max: number): string | undefined {
  if (s === undefined || s === null) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

export interface EventHeader {
  seq: number;
  tMonoNs: bigint;
  type: number;
  requestId: bigint;
  spanId: bigint;
}

export interface DecodedEvent {
  header: EventHeader;
  payload: Record<string, unknown>;
}

/**
 * ADR 015 hot path: writes the header into a caller-owned (reusable) buffer.
 * Scalar args on purpose — no per-event header object allocation.
 */
export function encodeHeaderInto(
  target: Buffer,
  seq: number,
  tMonoNs: bigint,
  type: number,
  requestId: bigint,
  spanId: bigint
): void {
  target.writeUInt32LE(seq >>> 0, 0);
  target.writeBigUInt64LE(tMonoNs, 4);
  target.writeUInt8(type & 0xff, 12);
  target.writeBigUInt64LE(requestId, 13);
  target.writeBigUInt64LE(spanId, 21);
}

export function encodeEvent(header: EventHeader, payload: unknown): Buffer {
  const body: Buffer = pack(payload);
  const buf = Buffer.allocUnsafe(HEADER_SIZE + body.length);
  encodeHeaderInto(buf, header.seq, header.tMonoNs, header.type, header.requestId, header.spanId);
  body.copy(buf, HEADER_SIZE);
  return buf;
}

/**
 * Round-trip is lossless for JSON payloads with two documented exceptions
 * (both fine for a flight recorder, and pinned by the encoder tests):
 *  - msgpackr renames `__proto__` keys to `__proto_` on decode (its
 *    prototype-pollution guard). We rely on this — .fbox payloads are
 *    untrusted input when opened by the viewer/CLI.
 *  - `-0` is encoded as integer `0` (same collapse JSON.stringify performs).
 */
export function decodeEvent(buf: Buffer): DecodedEvent {
  if (buf.length < HEADER_SIZE) {
    throw new RangeError(`event record too short: ${buf.length} bytes`);
  }
  return {
    header: {
      seq: buf.readUInt32LE(0),
      tMonoNs: buf.readBigUInt64LE(4),
      type: buf.readUInt8(12),
      requestId: buf.readBigUInt64LE(13),
      spanId: buf.readBigUInt64LE(21)
    },
    payload: unpack(buf.subarray(HEADER_SIZE))
  };
}
