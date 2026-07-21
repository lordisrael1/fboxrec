import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { parseIncident } from '@flightbox/format';
import * as flightbox from '../src/index';

/**
 * stop() must put the world back: every monkey-patch (http.Server emit,
 * http/https request+get, fetch, console.*) restored to the exact original
 * reference — except when other tooling wrapped over ours, in which case the
 * buried wrapper stays and passes through. start() after stop() must record
 * again.
 */

const nodeRequire = createRequire(import.meta.url);
const nodeHttp = nodeRequire('node:http');
const nodeHttps = nodeRequire('node:https');

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

let dir: string;

function start(): void {
  flightbox.start({ service: 'restore-test', bufferMb: 1, dir, log: () => {} });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbox-restore-'));
});

afterEach(() => {
  flightbox.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('stop() restores module patches', () => {
  it('returns every patched slot to its original reference', () => {
    const before = {
      emit: http.Server.prototype.emit,
      httpRequest: nodeHttp.request,
      httpGet: nodeHttp.get,
      httpsRequest: nodeHttps.request,
      httpsGet: nodeHttps.get,
      fetch: globalThis.fetch,
      console: Object.fromEntries(LEVELS.map((l) => [l, console[l]]))
    };

    start();

    // Sanity: the patches actually went in.
    expect(http.Server.prototype.emit).not.toBe(before.emit);
    expect(nodeHttp.request).not.toBe(before.httpRequest);
    expect(nodeHttp.get).not.toBe(before.httpGet);
    expect(nodeHttps.request).not.toBe(before.httpsRequest);
    expect(globalThis.fetch).not.toBe(before.fetch);
    for (const level of LEVELS) {
      expect(console[level]).not.toBe(before.console[level]);
    }

    flightbox.stop();

    expect(http.Server.prototype.emit).toBe(before.emit);
    expect(nodeHttp.request).toBe(before.httpRequest);
    expect(nodeHttp.get).toBe(before.httpGet);
    expect(nodeHttps.request).toBe(before.httpsRequest);
    expect(nodeHttps.get).toBe(before.httpsGet);
    expect(globalThis.fetch).toBe(before.fetch);
    for (const level of LEVELS) {
      expect(console[level]).toBe(before.console[level]);
    }
  });

  it('stop() is safe to call twice and before start()', () => {
    flightbox.stop();
    start();
    flightbox.stop();
    flightbox.stop();
  });

  it('records again after start → stop → start, and servers still work', async () => {
    start();
    flightbox.stop();
    start();

    const server = http.createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/after-restart`);
      expect(res.status).toBe(204);
      // Let the response 'finish' listener record the end event.
      await new Promise((resolve) => setTimeout(resolve, 50));

      console.log('after-restart marker');
      const staged = flightbox.trigger('restart test');
      expect(staged).toBeTruthy();

      const incident = await parseIncident(fs.readFileSync(staged!));
      const types = incident.events.map((e) => e.type);
      expect(types).toContain('http.server.start');
      expect(types).toContain('http.client.start');
      const logs = incident.events.filter((e) => e.type === 'log');
      expect(logs.some((e) => String(e.data.msg).includes('after-restart marker'))).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('conditionally: pg prototypes restored when pg is present', () => {
    let pg: any = null;
    try {
      pg = createRequire(path.join(process.cwd(), 'noop.js'))('pg');
    } catch {
      return; // pg not installed here — instrumentation self-skips, nothing to restore
    }
    const beforeQuery = pg.Client.prototype.query;
    const beforeConnect = pg.Pool?.prototype?.connect;
    start();
    expect(pg.Client.prototype.query).not.toBe(beforeQuery);
    flightbox.stop();
    expect(pg.Client.prototype.query).toBe(beforeQuery);
    if (beforeConnect) expect(pg.Pool.prototype.connect).toBe(beforeConnect);
  });

  // LAST in the file: it deliberately buries our console.log wrapper under a
  // foreign one, and only fully unwinds at the end.
  it('leaves a foreign wrapper intact and reactivates the buried patch on restart', async () => {
    const trueOriginal = console.log;
    start();
    const ourWrapper = console.log;

    let foreignCalls = 0;
    const foreignWrapper = (...args: unknown[]): void => {
      foreignCalls++;
      ourWrapper(...args);
    };
    console.log = foreignWrapper;

    flightbox.stop();
    // Ours is buried: stop() must NOT clobber the foreign wrapper...
    expect(console.log).toBe(foreignWrapper);
    // ...and the buried wrapper passes through without recording or throwing.
    console.log('while stopped');
    expect(foreignCalls).toBe(1);

    // Restart reactivates the buried wrapper instead of double-patching.
    start();
    console.log('buried marker');
    const staged = flightbox.trigger('buried wrapper test');
    expect(staged).toBeTruthy();
    const incident = await parseIncident(fs.readFileSync(staged!));
    const logs = incident.events.filter((e) => e.type === 'log');
    expect(logs.filter((e) => String(e.data.msg).includes('buried marker'))).toHaveLength(1);
    flightbox.stop();

    // Foreign tooling unwinds itself; ours is on top again and the next
    // start/stop cycle restores the true original.
    console.log = ourWrapper;
    start();
    flightbox.stop();
    expect(console.log).toBe(trueOriginal);
  });
});
