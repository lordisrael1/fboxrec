import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { Incident } from '@flightbox/format';
import * as flightbox from '../src/index';

let dir: string;
let server: http.Server;
let port: number;
let releaseHang: (() => void) | null = null;

function stagingDir(): string {
  return path.join(dir, 'staging', `pid-${process.pid}`);
}

function listIncidents(): Incident[] {
  try {
    return fs
      .readdirSync(stagingDir())
      .filter((f) => f.endsWith('.fbox'))
      .map((f) =>
        JSON.parse(gunzipSync(fs.readFileSync(path.join(stagingDir(), f))).toString('utf8'))
      );
  } catch {
    return [];
  }
}

async function waitForIncident(
  predicate: (i: Incident) => boolean,
  timeoutMs = 5000
): Promise<Incident> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = listIncidents().find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error('timed out waiting for incident');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbox-trig-'));
  flightbox.start({
    service: 'trigger-test',
    bufferMb: 1,
    dir,
    token: 'sekret',
    triggers: { slowRequestMs: 80, cooldownMs: 0, stallMs: 1e9, heapPct: 0.999 },
    shedding: { shedLagMs: 1e9 }, // keep shedding out of these tests
    log: () => {}
  });
  server = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/slow')) {
      await new Promise((r) => setTimeout(r, 150));
      res.end('slow ok');
    } else if (req.url?.startsWith('/hang')) {
      releaseHang = () => res.end('finally');
      // never responds until released
    } else if (req.url?.startsWith('/outbound')) {
      const r = await fetch(`http://127.0.0.1:${port}/fast`);
      await r.text();
      res.end('outbound ok');
    } else {
      res.end('fast ok');
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  releaseHang?.();
  await new Promise((r) => server.close(r));
  flightbox.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('trigger engine (Week 2)', () => {
  it('slow-request trigger fires at request end and dumps asynchronously (ADR 016)', async () => {
    await (await fetch(`http://127.0.0.1:${port}/slow`)).text();
    const incident = await waitForIncident(
      (i) => i.meta.trigger.type === 'slowRequest' && !i.meta.trigger.reason!.includes('watchdog')
    );
    expect(incident.meta.trigger.reason).toContain('/slow');
  });

  it('in-flight watchdog catches hung requests that never finish', async () => {
    void fetch(`http://127.0.0.1:${port}/hang`).catch(() => {});
    const incident = await waitForIncident(
      (i) => i.meta.trigger.type === 'slowRequest' && Boolean(i.meta.trigger.reason?.includes('watchdog')),
      6000
    );
    expect(incident.meta.trigger.reason).toContain('/hang');
  });

  it('uncaughtException path dumps synchronously without altering crash semantics', () => {
    (process as any).emit('uncaughtExceptionMonitor', new Error('boom-test'));
    const incident = listIncidents().find((i) => i.meta.trigger.type === 'uncaughtException');
    expect(incident).toBeDefined();
    expect(incident!.meta.trigger.reason).toContain('boom-test');
    const marker = incident!.events.find(
      (e) => e.type === 'custom' && e.data.name === 'uncaughtException'
    );
    expect(marker).toBeDefined();
  });

  it('correlates console logs and outbound http to the parent request; vitals present', async () => {
    await new Promise((r) => setTimeout(r, 350)); // let the 100ms sampler tick
    console.log('hello from the handler test, order 42');
    await (await fetch(`http://127.0.0.1:${port}/outbound`)).text();
    await new Promise((r) => setTimeout(r, 50));

    const staged = flightbox.trigger('correlation check');
    expect(staged).toBeTruthy();
    const incident: Incident = JSON.parse(gunzipSync(fs.readFileSync(staged!)).toString('utf8'));

    const types = incident.events.map((e) => e.type);
    expect(types).toContain('log');
    expect(types).toContain('vitals');
    expect(types).toContain('http.client.start');
    expect(types).toContain('http.client.end');

    const serverStart = incident.events.find(
      (e) => e.type === 'http.server.start' && (e.data.path as string).startsWith('/outbound')
    )!;
    // Specifically the fetch made INSIDE the /outbound handler (the test
    // file's own fetches are correctly recorded as orphan).
    const clientStart = incident.events.find(
      (e) => e.type === 'http.client.start' && (e.data.path as string).startsWith('/fast')
    )!;
    expect(clientStart.requestId).toBe(serverStart.requestId);
    expect(clientStart.requestId).not.toBe('orphan');

    const log = incident.events.find((e) => e.type === 'log')!;
    expect(log.data.msg).toContain('order 42');
  });

  it('token-gated manual dump endpoint: header-only auth (audit M6)', async () => {
    const bad = await fetch(`http://127.0.0.1:${port}/__flightbox/dump`, {
      headers: { 'x-flightbox-token': 'wrong' }
    });
    expect(bad.status).toBe(401);

    // Query-string tokens leak into access logs — no longer accepted.
    const query = await fetch(`http://127.0.0.1:${port}/__flightbox/dump?token=sekret`);
    expect(query.status).toBe(401);

    const good = await fetch(`http://127.0.0.1:${port}/__flightbox/dump?reason=ops`, {
      headers: { 'x-flightbox-token': 'sekret' }
    });
    expect(good.status).toBe(200);
    const body = (await good.json()) as { staged: string | null };
    expect(body.staged).toBeTruthy();
    expect(fs.existsSync(body.staged!)).toBe(true);
  });

  it('only intercepts the exact /__flightbox/dump pathname — sibling app routes pass through', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__flightbox/dump-report`, {
      headers: { 'x-flightbox-token': 'sekret' }
    });
    // Reached the app's fallback route, not the flightbox endpoint.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fast ok');
  });

  it('dump endpoint is GET-only (audit): non-GET gets 405', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__flightbox/dump`, {
      method: 'POST',
      headers: { 'x-flightbox-token': 'sekret' }
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('dump endpoint scrubs and caps the reason param (audit)', async () => {
    const secret = 'password=hunter2';
    const huge = 'A'.repeat(5000);
    const res = await fetch(
      `http://127.0.0.1:${port}/__flightbox/dump?reason=${encodeURIComponent(secret + ' ' + huge)}`,
      { headers: { 'x-flightbox-token': 'sekret' } }
    );
    // Read the EXACT file this call staged (not any earlier manual dump).
    const { staged } = (await res.json()) as { staged: string };
    const incident: Incident = JSON.parse(gunzipSync(fs.readFileSync(staged)).toString('utf8'));
    expect(incident.meta.trigger.reason).toContain('[REDACTED]');
    expect(incident.meta.trigger.reason).not.toContain('hunter2');
    // Capped well below the 5000-char injection.
    expect(incident.meta.trigger.reason!.length).toBeLessThan(200);
  });

  it('unhandledRejection: rethrows only when Flightbox is the sole listener (audit H1)', () => {
    const all = process.listeners('unhandledRejection');
    // Flightbox's listener is the one start() installed (vitest may add its own).
    const fbListener = all.find((l) => l.toString().includes('crashDump'))!;
    expect(fbListener).toBeDefined();
    const others = all.filter((l) => l !== fbListener);
    const appHandler = (): void => {}; // the log-and-survive pattern
    process.on('unhandledRejection', appHandler);
    try {
      // App-has-a-handler case: never throw — the app decided to survive;
      // Flightbox records and steps aside.
      expect(() => fbListener(new Error('survivable'), Promise.resolve())).not.toThrow();

      // Sole-listener case: default crash-the-process semantics preserved.
      process.removeListener('unhandledRejection', appHandler);
      for (const l of others) process.removeListener('unhandledRejection', l);
      expect(process.listenerCount('unhandledRejection')).toBe(1);
      expect(() => fbListener(new Error('fatal'), Promise.resolve())).toThrow('fatal');
    } finally {
      process.removeListener('unhandledRejection', appHandler);
      for (const l of others) process.on('unhandledRejection', l);
    }
  });
});
