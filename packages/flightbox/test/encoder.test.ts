import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  encodeEvent,
  decodeEvent,
  truncate,
  EventType,
  HEADER_SIZE
} from '../src/encoder';

/**
 * The documented lossy edges of the wire format (see encoder.ts):
 * `__proto__` keys become `__proto_` (msgpackr pollution guard) and `-0`
 * collapses to `0`.
 */
function expectedDecode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(expectedDecode);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      out[k === '__proto__' ? '__proto_' : k] = expectedDecode(
        (v as Record<string, unknown>)[k]
      );
    }
    return out;
  }
  if (typeof v === 'number' && Object.is(v, -0)) return 0;
  return v;
}

describe('encoder', () => {
  it('round-trips a typical event', () => {
    const header = {
      seq: 42,
      tMonoNs: 123456789012345n,
      type: EventType.PgQueryStart,
      requestId: 7n,
      spanId: 9n
    };
    const payload = { text: 'SELECT 1', params: ['string', 'number'] };
    const decoded = decodeEvent(encodeEvent(header, payload));
    expect(decoded.header).toEqual(header);
    expect(decoded.payload).toEqual(payload);
  });

  it('encodes the documented 29-byte header', () => {
    const buf = encodeEvent(
      { seq: 0, tMonoNs: 0n, type: 1, requestId: 0n, spanId: 0n },
      null
    );
    expect(buf.length).toBe(HEADER_SIZE + 1); // msgpack null = 1 byte
  });

  it('rejects records shorter than the header', () => {
    expect(() => decodeEvent(Buffer.alloc(10))).toThrow(RangeError);
  });

  it('property: header + arbitrary JSON payload round-trip losslessly (modulo documented lossy edges)', () => {
    fc.assert(
      fc.property(
        fc.record({
          seq: fc.integer({ min: 0, max: 0xffffffff }),
          tMonoNs: fc.bigUintN(64),
          type: fc.integer({ min: 0, max: 255 }),
          requestId: fc.bigUintN(64),
          spanId: fc.bigUintN(64)
        }),
        fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 3 }), { maxKeys: 8 }),
        (header, payload) => {
          const decoded = decodeEvent(encodeEvent(header, payload));
          expect(decoded.header).toEqual(header);
          expect(decoded.payload).toEqual(expectedDecode(payload));
        }
      ),
      { numRuns: 200 }
    );
  });

  it('collapses -0 to 0 (documented lossy edge)', () => {
    const header = { seq: 0, tMonoNs: 0n, type: 1, requestId: 0n, spanId: 0n };
    const decoded = decodeEvent(encodeEvent(header, { z: -0 }));
    expect(Object.is(decoded.payload.z, 0)).toBe(true);
  });

  it('sanitizes literal __proto__ keys on decode (msgpackr prototype-pollution guard)', () => {
    const header = { seq: 0, tMonoNs: 0n, type: 1, requestId: 0n, spanId: 0n };
    // Computed key creates an own property; bare `__proto__:` would set the prototype.
    const payload = { ['__proto__']: 'evil', nested: { ['__proto__']: 1 } };
    const decoded = decodeEvent(encodeEvent(header, payload));
    expect(decoded.payload).toEqual({ __proto_: 'evil', nested: { __proto_: 1 } });
    expect(Object.getPrototypeOf(decoded.payload)).toBe(Object.prototype);
  });

  it('truncate caps long strings and passes short ones through', () => {
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(truncate('ab', 3)).toBe('ab');
    expect(truncate(undefined, 3)).toBeUndefined();
    expect(truncate(null, 3)).toBeUndefined();
  });
});
