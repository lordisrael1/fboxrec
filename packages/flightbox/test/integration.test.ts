import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseIncident, type Incident } from '@flightbox/format';
import * as flightbox from '../src/index';

/**
 * The Week 1 milestone, as a test: request hits an instrumented server →
 * manual trigger → staged .fbox opens as correlated, request-scoped events.
 */

let dir: string;
let server: http.Server;
let port: number;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbox-int-'));
  flightbox.start({
    service: 'integration-test',
    bufferMb: 1,
    dir,
    log: () => {}
  });
  server = http.createServer((req, res) => {
    res.statusCode = 201;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  flightbox.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('flightbox end-to-end (Week 1 milestone)', () => {
  let incident: Incident;
  let stagedPath: string;

  it('captures an incident with correlated request events', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/orders/42?verbose=1`);
    await res.text();
    // Let the res 'finish' listener run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    flightbox.addEvent('checkout.processed', { orderId: 42 });

    const staged = flightbox.trigger('integration test');
    expect(staged).toBeTruthy();
    stagedPath = staged!;

    incident = await parseIncident(fs.readFileSync(stagedPath));
    expect(incident.formatVersion).toBe(1);
    expect(incident.meta.service).toBe('integration-test');
    expect(incident.meta.trigger).toEqual({
      type: 'manual',
      reason: 'integration test'
    });

    const types = incident.events.map((e) => e.type);
    expect(types).toContain('http.server.start');
    expect(types).toContain('http.server.end');
    expect(types).toContain('custom');
    expect(types).toContain('trigger');

    // Start and end are correlated by a real (non-orphan) requestId.
    const start = incident.events.find((e) => e.type === 'http.server.start')!;
    const end = incident.events.find((e) => e.type === 'http.server.end')!;
    expect(start.requestId).not.toBe('orphan');
    expect(end.requestId).toBe(start.requestId);
    expect(start.data.path).toBe('/orders/42?verbose=1');
    expect(end.data.status).toBe(201);
    expect(end.data.durMs).toBeGreaterThanOrEqual(0);

    // The custom event fired outside any request: orphan by design (ADR 004).
    const custom = incident.events.find((e) => e.type === 'custom')!;
    expect(custom.requestId).toBe('orphan');
    expect(custom.data).toMatchObject({ name: 'checkout.processed', orderId: 42 });

    // Events are chronological.
    const seqs = incident.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('suppresses re-triggers inside the cooldown: one storm = one file', () => {
    expect(flightbox.trigger('again')).toBeNull();
    const files = fs
      .readdirSync(path.dirname(stagedPath))
      .filter((f) => f.endsWith('.fbox'));
    expect(files).toHaveLength(1);
  });
});
