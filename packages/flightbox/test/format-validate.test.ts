import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { validateIncident, parseIncident, MAX_EVENT_COUNT } from '@flightbox/format';

/** Audit H2: malformed incidents must fail with a human message at parse
 * time, never as a blank page deep inside the viewer's render. */

const GOOD = {
  formatVersion: 1,
  meta: {
    service: 's',
    capturedAt: new Date().toISOString(),
    wallAnchor: { wallMs: 0, monoNs: '0' },
    trigger: { type: 'manual' },
    eventCount: 1,
    windowMs: 0,
    flightboxVersion: '0.0.0'
  },
  events: [
    { seq: 0, wallMs: 1, tMonoNs: '0', type: 'custom', requestId: 'orphan', spanId: '0', data: {} }
  ]
};

describe('validateIncident (audit H2)', () => {
  it('accepts a well-formed incident', () => {
    expect(() => validateIncident(GOOD)).not.toThrow();
  });

  it.each([
    ['empty meta', { ...GOOD, meta: {} }, /meta\.service/],
    ['missing trigger.type', { ...GOOD, meta: { ...GOOD.meta, trigger: {} } }, /meta\.trigger\.type/],
    ['string eventCount', { ...GOOD, meta: { ...GOOD.meta, eventCount: 'many' } }, /eventCount/],
    [
      'event with non-numeric wallMs',
      { ...GOOD, events: [{ ...GOOD.events[0], wallMs: 'yesterday' }] },
      /event #0/
    ],
    [
      'event with null data',
      { ...GOOD, events: [{ ...GOOD.events[0], data: null }] },
      /event #0/
    ],
    ['newer formatVersion', { ...GOOD, formatVersion: 999 }, /only understands/]
  ])('rejects %s with an actionable message', (_name, incident, msgRe) => {
    expect(() => validateIncident(incident)).toThrow(msgRe);
  });
});

describe('parseIncident untrusted-input limits (audit)', () => {
  it('parses a normal gzipped incident', async () => {
    const parsed = await parseIncident(gzipSync(JSON.stringify(GOOD)));
    expect(parsed.meta.service).toBe('s');
  });

  it('rejects an incident whose event count exceeds the viewer cap', async () => {
    // Build the over-cap array of shared references and feed a plain JSON
    // string (no gzip round-trip) so the test stays fast; the guard fires
    // after validation regardless of input encoding.
    const one = GOOD.events[0];
    const many = { ...GOOD, events: new Array(MAX_EVENT_COUNT + 1).fill(one) };
    await expect(parseIncident(JSON.stringify(many))).rejects.toThrow(/above the/);
  }, 30_000);

  it('malformed gzip content fails cleanly rather than hanging', async () => {
    // Well-formed gzip wrapping non-JSON must reject with a clear message,
    // not throw an opaque error or spin. (The decompressed-BYTE cap is
    // enforced separately via zlib maxOutputLength / the streamed running
    // total in gunzip(); exercising a >1 GiB expansion would need >1 GiB of
    // RAM, so it is covered by the smoke path, not this unit test.)
    const notJson = gzipSync(Buffer.from('x'.repeat(1024)));
    await expect(parseIncident(notJson)).rejects.toThrow(/neither gzipped JSON nor plain JSON/);
  });
});
