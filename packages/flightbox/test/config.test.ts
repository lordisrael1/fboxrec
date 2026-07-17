import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config';

describe('config validation', () => {
  it('resolves defaults', () => {
    const c = resolveConfig();
    expect(c.bufferMb).toBe(64);
    expect(c.triggers.stallMs).toBe(1000);
    expect(c.shedding.shedLagMs).toBe(50);
  });

  it.each([
    ['bufferMb out of range', { bufferMb: 0 }],
    ['slowRequestMs too small', { triggers: { slowRequestMs: 1 } }],
    ['negative cooldownMs', { triggers: { cooldownMs: -1 } }],
    ['heapPct out of (0,1)', { triggers: { heapPct: 1.5 } }],
    ['non-finite stallMs', { triggers: { stallMs: NaN } }],
    ['stallMs too small', { triggers: { stallMs: 5 } }],
    ['non-finite shedLagMs', { shedding: { shedLagMs: Infinity } }],
    ['shedLagMs below 1', { shedding: { shedLagMs: 0 } }],
    ['maxStageMb below 1', { staging: { maxStageMb: 0 } }],
    ['minDiskFreePct above 50', { staging: { minDiskFreePct: 90 } }]
  ])('rejects %s', (_name, user) => {
    expect(() => resolveConfig(user as never)).toThrow(RangeError);
  });

  describe('sink validation (audit)', () => {
    it.each([
      ['s3 without bucket', { sinks: [{ type: 's3' }] }, /bucket/],
      ['s3 bad endpoint', { sinks: [{ type: 's3', bucket: 'b', endpoint: 'ftp://x' }] }, /endpoint/],
      ['s3 absurd presign lifetime', { sinks: [{ type: 's3', bucket: 'b', presign: { expiresHours: 9999 } }] }, /expiresHours/],
      ['http bad url', { sinks: [{ type: 'http', url: 'not-a-url' }] }, /url/],
      ['disk without dir', { sinks: [{ type: 'disk' }] }, /dir/],
      ['disk bad maxMb', { sinks: [{ type: 'disk', dir: '/tmp/x', maxMb: 0 }] }, /maxMb/],
      ['unknown sink type', { sinks: [{ type: 'ftp' }] }, /unknown sink/]
    ])('rejects %s', (_name, user, msgRe) => {
      expect(() => resolveConfig(user as never)).toThrow(msgRe);
    });

    it('accepts well-formed sinks', () => {
      const c = resolveConfig({
        sinks: [
          { type: 's3', bucket: 'acme', prefix: 'prod/', presign: { expiresHours: 24 } },
          { type: 'http', url: 'https://collector.example/incidents' },
          { type: 'disk', dir: '/var/incidents', maxMb: 200 }
        ]
      } as never);
      expect(c.sinks).toHaveLength(3);
    });
  });
});
