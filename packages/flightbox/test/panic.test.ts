import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseIncident } from '@flightbox/format';
import { RingBuffer } from '../src/ring-buffer';
import { encodeEvent, EventType } from '../src/encoder';
import { nowMono } from '../src/clock';
import { Staging } from '../src/dump/stage';
import { PanicWriter, recoverPanicFiles, PANIC_HEADER_LEN } from '../src/dump/panic';

const LIMITS = { maxStageMb: 500, minDiskFreePct: 0 };
const silent = (): void => {};

let base: string;
let staging: Staging;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fbox-panic-'));
  staging = new Staging(base, LIMITS, silent);
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function fillRing(ring: RingBuffer, n: number): void {
  const t0 = nowMono();
  for (let i = 0; i < n; i++) {
    ring.write(
      encodeEvent(
        {
          seq: i,
          tMonoNs: t0 + BigInt(i) * 1_000_000n,
          type: EventType.Custom,
          requestId: 0n,
          spanId: 0n
        },
        { name: `e${i}` }
      )
    );
  }
}

describe('panic path (ADR 009)', () => {
  it('raw-dumps the ring and recovers it as a normal .fbox on next boot', async () => {
    const ring = new RingBuffer(4096);
    fillRing(ring, 6);

    const writer = new PanicWriter(staging.stagingDir);
    writer.arm();
    expect(writer.writeSync(ring)).toBe(true);
    // Simulate process death releasing the fd (file is NOT swept: size > 0).
    writer.disarm();
    expect(fs.statSync(writer.filePath).size).toBe(PANIC_HEADER_LEN + 4096);

    expect(recoverPanicFiles(staging, 'panic-svc', silent)).toBe(1);
    expect(fs.existsSync(writer.filePath)).toBe(false);

    const staged = staging.listStagedSync();
    expect(staged).toHaveLength(1);
    const incident = await parseIncident(fs.readFileSync(staged[0]!));
    expect(incident.meta.trigger.type).toBe('panic');
    expect(incident.meta.service).toBe('panic-svc');
    expect(incident.events.map((e) => e.data.name)).toEqual([
      'e0',
      'e1',
      'e2',
      'e3',
      'e4',
      'e5'
    ]);
  });

  it('sweeps empty placeholders from clean runs', () => {
    const writer = new PanicWriter(staging.stagingDir);
    writer.arm();
    expect(fs.existsSync(writer.filePath)).toBe(true);
    writer.disarm();
    expect(fs.existsSync(writer.filePath)).toBe(false);
  });

  it('quarantines unparseable panic files as .corrupt instead of deleting', () => {
    const junk = path.join(staging.stagingDir, 'panic-1.fboxpanic');
    fs.writeFileSync(junk, Buffer.alloc(PANIC_HEADER_LEN + 10, 0xab));
    expect(recoverPanicFiles(staging, 'svc', silent)).toBe(0);
    expect(fs.existsSync(junk)).toBe(false);
    expect(fs.existsSync(junk + '.corrupt')).toBe(true);
  });
});
