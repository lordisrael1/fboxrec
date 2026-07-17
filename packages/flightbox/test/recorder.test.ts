import { describe, expect, it } from 'vitest';
import { Recorder, MAX_EVENT_PAYLOAD_BYTES } from '../src/recorder';
import { RingBuffer } from '../src/ring-buffer';
import { EventType } from '../src/encoder';

describe('Recorder payload cap (audit)', () => {
  it('replaces an oversized payload with a small marker, never the blob', () => {
    const rec = new Recorder(new RingBuffer(8 * 1024 * 1024));
    rec.armed = true;
    // addEvent() accepts arbitrary user data — a giant string must not
    // occupy a huge slice of the ring.
    rec.record(EventType.Custom, { blob: 'x'.repeat(2 * MAX_EVENT_PAYLOAD_BYTES) });
    const events = rec.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ __truncated: true });
    expect(typeof events[0]!.payload.originalBytes).toBe('number');
  });

  it('normal payloads pass through intact', () => {
    const rec = new Recorder(new RingBuffer(1024 * 1024));
    rec.armed = true;
    rec.record(EventType.Log, { level: 'info', msg: 'hello' });
    expect(rec.snapshot()[0]!.payload).toEqual({ level: 'info', msg: 'hello' });
  });
});
