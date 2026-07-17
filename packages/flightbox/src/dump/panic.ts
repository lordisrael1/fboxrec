import * as fs from 'node:fs';
import * as path from 'node:path';
import { RingBuffer } from '../ring-buffer';
import { decodeEvent, type DecodedEvent } from '../encoder';
import { getAnchor, type ClockAnchor } from '../clock';
import { serializeIncident } from './serializer';
import type { Staging } from './stage';

/**
 * ADR 009 — the OOM panic path. When the process is dying BECAUSE the heap
 * is exhausted, gzip/msgpack/envelope building would abort V8 before the
 * crash handler finishes. This module writes the RAW ring bytes through a
 * fd preopened at start() (when memory was plentiful):
 *
 *   [44-byte panic header][ring buffer bytes, verbatim]
 *
 * Header (LE): magic "FBOXPANC" (8) | version u32 | capacity u32 |
 * oldest u32 | count u32 | anchor wallMs f64 | anchor monoNs u64 | 4 reserved.
 *
 * The next boot converts .fboxpanic files into normal .fbox incidents —
 * memory is plentiful again by then. The no-split framing invariant
 * (ADR 011) is what makes the raw image parseable.
 */

const MAGIC = Buffer.from('FBOXPANC', 'ascii');
const PANIC_VERSION = 1;
export const PANIC_HEADER_LEN = 44;

export class PanicWriter {
  private fd: number | null = null;
  /** Preallocated so panic-time writes allocate (nearly) nothing. */
  private readonly header = Buffer.alloc(PANIC_HEADER_LEN);
  readonly filePath: string;

  constructor(stagingDir: string) {
    this.filePath = path.join(stagingDir, `panic-${process.pid}.fboxpanic`);
  }

  /** Preopen the fd while memory is plentiful. Failure is non-fatal. */
  arm(): void {
    try {
      this.fd = fs.openSync(this.filePath, 'w');
    } catch {
      this.fd = null;
    }
  }

  /**
   * The panic dump: no gzip, no decode, no envelope — raw ring bytes onto
   * the preopened fd. Safe to call with V8 near the heap limit.
   */
  writeSync(ring: RingBuffer): boolean {
    if (this.fd === null) return false;
    try {
      const state = ring.rawState;
      const anchor = getAnchor();
      MAGIC.copy(this.header, 0);
      this.header.writeUInt32LE(PANIC_VERSION, 8);
      this.header.writeUInt32LE(ring.capacity, 12);
      this.header.writeUInt32LE(state.oldest, 16);
      this.header.writeUInt32LE(state.count, 20);
      this.header.writeDoubleLE(anchor.wallMs, 24);
      this.header.writeBigUInt64LE(anchor.monoNs, 32);
      fs.writeSync(this.fd, this.header, 0, PANIC_HEADER_LEN, 0);
      fs.writeSync(this.fd, state.buf, 0, state.buf.length, PANIC_HEADER_LEN);
      fs.fsyncSync(this.fd);
      return true;
    } catch {
      return false;
    }
  }

  /** Clean shutdown: close the fd and sweep the empty placeholder. */
  disarm(): void {
    try {
      if (this.fd !== null) fs.closeSync(this.fd);
      this.fd = null;
      if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size === 0) {
        fs.unlinkSync(this.filePath);
      }
    } catch {
      this.fd = null;
    }
  }
}

interface ParsedPanic {
  anchor: ClockAnchor;
  events: DecodedEvent[];
}

function parsePanicFile(raw: Buffer): ParsedPanic | null {
  if (raw.length < PANIC_HEADER_LEN || !raw.subarray(0, 8).equals(MAGIC)) return null;
  if (raw.readUInt32LE(8) !== PANIC_VERSION) return null;
  const capacity = raw.readUInt32LE(12);
  const oldest = raw.readUInt32LE(16);
  const count = raw.readUInt32LE(20);
  const wallMs = raw.readDoubleLE(24);
  const monoNs = raw.readBigUInt64LE(32);
  const body = raw.subarray(PANIC_HEADER_LEN);
  if (body.length !== capacity || oldest >= capacity) return null;

  const events: DecodedEvent[] = [];
  for (const rec of RingBuffer.readRecords(body, capacity, oldest, count)) {
    try {
      events.push(decodeEvent(rec));
    } catch {
      // A frame torn by the crash — skip it, keep the rest.
    }
  }
  // The raw image is in buffer order, not time order; restore chronology.
  events.sort((a, b) =>
    a.header.tMonoNs < b.header.tMonoNs ? -1 : a.header.tMonoNs > b.header.tMonoNs ? 1 : 0
  );
  return { anchor: { wallMs, monoNs }, events };
}

/**
 * Boot-time conversion pass: turn every .fboxpanic in our staging dir
 * (our own crashed run's, or ones adopted from dead workers, ADR 010) into
 * a normal .fbox incident. Empty placeholders are swept; unparseable files
 * are renamed .corrupt, never silently deleted.
 */
export function recoverPanicFiles(
  staging: Staging,
  service: string,
  log: (msg: string) => void
): number {
  let recovered = 0;
  for (const file of staging.listPanicSync()) {
    try {
      if (fs.statSync(file).size < PANIC_HEADER_LEN) {
        fs.unlinkSync(file); // placeholder from a clean or failed-arm run
        continue;
      }
      const parsed = parsePanicFile(fs.readFileSync(file));
      if (parsed === null) {
        fs.renameSync(file, file + '.corrupt');
        log(`panic dump ${path.basename(file)} is unparseable — kept as .corrupt`);
        continue;
      }
      const { fileName, data, eventCount } = serializeIncident({
        service,
        trigger: { type: 'panic', reason: 'recovered from crash-time panic dump' },
        events: parsed.events,
        anchor: parsed.anchor
      });
      staging.stageSync(fileName, data);
      fs.unlinkSync(file);
      recovered++;
      log(`recovered panic dump → ${fileName} (${eventCount} events)`);
    } catch (err) {
      log(`panic recovery failed for ${path.basename(file)}: ${(err as Error).message}`);
    }
  }
  return recovered;
}
