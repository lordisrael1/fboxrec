import { pack } from 'msgpackr';
import { RingBuffer } from './ring-buffer';
import {
  encodeHeaderInto,
  decodeEvent,
  HEADER_SIZE,
  type DecodedEvent,
  type EventType
} from './encoder';
import { nowMono } from './clock';
import { currentRequestId } from './context';

// ADR 015: one scratch header for the process lifetime — record() copies it
// into the ring immediately, so reuse is safe and per-event allocation-free.
const scratchHeader = Buffer.allocUnsafe(HEADER_SIZE);

/**
 * Hard per-event payload cap. addEvent() accepts arbitrary user objects;
 * without this, one call could occupy a huge slice of the ring and balloon
 * dump size. Oversized payloads are replaced by a small marker (the event's
 * existence is still forensic signal), never silently dropped.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

export interface RecordOptions {
  requestId?: bigint;
  spanId?: bigint;
  tMonoNs?: bigint;
}

/**
 * The glue between instrumentations and the ring buffer.
 *
 * Iron rule: record() NEVER throws into user code and never does I/O —
 * encode + copy into the preallocated ring, nothing else.
 */
export class Recorder {
  armed = false;
  private seq = 0;

  constructor(private ring: RingBuffer) {}

  record(type: EventType, payload: Record<string, unknown>, opts?: RecordOptions): void {
    if (!this.armed) return;
    try {
      // ADR 015 zero-allocation path: scratch header + msgpackr's reused
      // internal buffer, both copied into the preallocated ring in one
      // vectored write. No intermediate record buffer is ever allocated.
      encodeHeaderInto(
        scratchHeader,
        this.seq++ >>> 0,
        opts?.tMonoNs ?? nowMono(),
        type,
        opts?.requestId ?? currentRequestId(),
        opts?.spanId ?? 0n
      );
      let body = pack(payload);
      if (body.length > MAX_EVENT_PAYLOAD_BYTES) {
        body = pack({ __truncated: true, originalBytes: body.length });
      }
      this.ring.write(scratchHeader, body);
    } catch {
      // Failure degrades to "this event wasn't recorded" — never to a crash.
    }
  }

  /**
   * ADR 005 — zero-lock freeze: swap in a fresh ring for active writes and
   * return the frozen one. Incoming traffic keeps recording into the new
   * buffer while the frozen segment is serialized; the frozen bytes can
   * never be overwritten mid-dump.
   *
   * `replacementBytes` lets memory-pressure dumps swap in a SMALL emergency
   * ring instead of another full-size allocation — allocating 64MB (or up
   * to 4GB) at the exact moment the heap trigger fired would deepen the
   * incident being recorded. The next normal-path dump restores full size.
   */
  freezeAndSwap(replacementBytes?: number): RingBuffer {
    const frozen = this.ring;
    this.ring = new RingBuffer(
      Math.min(replacementBytes ?? frozen.capacity, frozen.capacity)
    );
    return frozen;
  }

  /** Decode a chronological copy of the active buffer. Recording continues. */
  snapshot(): DecodedEvent[] {
    return decodeRing(this.ring);
  }

  get eventCount(): number {
    return this.ring.size;
  }

  /** ADR 009 panic path ONLY — raw access to the live ring. */
  get activeRing(): RingBuffer {
    return this.ring;
  }
}

export function decodeRing(ring: RingBuffer): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const rec of ring.snapshot()) {
    try {
      out.push(decodeEvent(rec));
    } catch {
      // Skip a corrupt record rather than lose the dump.
    }
  }
  return out;
}
