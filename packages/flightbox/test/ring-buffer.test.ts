import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { RingBuffer } from '../src/ring-buffer';

describe('RingBuffer', () => {
  it('round-trips a single record', () => {
    const ring = new RingBuffer(64);
    const payload = Buffer.from('hello world');
    expect(ring.write(payload)).toBe(true);
    const snap = ring.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.equals(payload)).toBe(true);
  });

  it('returns an empty snapshot when nothing was written', () => {
    expect(new RingBuffer(64).snapshot()).toEqual([]);
  });

  it('drops records larger than total capacity and counts them', () => {
    const ring = new RingBuffer(16);
    expect(ring.write(Buffer.alloc(20))).toBe(false);
    expect(ring.dropped).toBe(1);
    expect(ring.size).toBe(0);
  });

  it('wraps without splitting records (ADR 011) and evicts the oldest', () => {
    // cap 32: two 10-byte records fill [0,14) and [14,28); the third does
    // not fit the 4-byte tail, wraps whole to 0, evicting record 1.
    const ring = new RingBuffer(32);
    const p1 = Buffer.from('AAAAAAAAAA');
    const p2 = Buffer.from('BBBBBBBBBB');
    const p3 = Buffer.from('CCCCCCCCCC');
    ring.write(p1);
    ring.write(p2);
    ring.write(p3);
    const snap = ring.snapshot();
    expect(snap.map((b) => b.toString())).toEqual([p2.toString(), p3.toString()]);
  });

  it('handles zero-length payloads', () => {
    const ring = new RingBuffer(16);
    expect(ring.write(Buffer.alloc(0))).toBe(true);
    expect(ring.snapshot()).toHaveLength(1);
    expect(ring.snapshot()[0]!.length).toBe(0);
  });

  it('property: snapshot is always a byte-identical suffix of accepted writes, within capacity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 64, max: 2048 }),
        fc.array(fc.uint8Array({ maxLength: 300 }), { maxLength: 150 }),
        (cap, payloads) => {
          const ring = new RingBuffer(cap);
          const accepted: Uint8Array[] = [];
          for (const p of payloads) {
            if (ring.write(Buffer.from(p))) accepted.push(p);
          }

          const snap = ring.snapshot();
          expect(ring.size).toBe(snap.length);
          expect(snap.length).toBeLessThanOrEqual(accepted.length);
          if (accepted.length > 0) expect(snap.length).toBeGreaterThan(0);

          // Chronological suffix: the last N accepted writes, byte-identical.
          const expected = accepted.slice(accepted.length - snap.length);
          snap.forEach((buf, i) => {
            expect(buf.equals(Buffer.from(expected[i]!))).toBe(true);
          });

          // Framed bytes can never exceed the preallocated capacity.
          const framedBytes = snap.reduce((sum, b) => sum + b.length + 4, 0);
          expect(framedBytes).toBeLessThanOrEqual(cap);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('property: interleaved snapshots never disturb subsequent writes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ maxLength: 60 }), { minLength: 1, maxLength: 60 }),
        (payloads) => {
          const ring = new RingBuffer(256);
          for (const p of payloads) {
            ring.write(Buffer.from(p));
            ring.snapshot(); // must be a pure read
          }
          const snap = ring.snapshot();
          const tail = payloads.slice(payloads.length - snap.length);
          snap.forEach((buf, i) => {
            expect(buf.equals(Buffer.from(tail[i]!))).toBe(true);
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});
