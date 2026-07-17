import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * CLI smoke (Bible §9): `flightbox open fixture.fbox` serves the bundled
 * viewer and exposes the incident at an unguessable /__incident-<hex> path,
 * rejecting non-localhost Host headers (audit M5). Requires dist/ AND
 * viewer-dist/ (pnpm build); skipped otherwise.
 */

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(pkgRoot, 'dist', 'cli', 'main.cjs');
const hasBuild =
  fs.existsSync(cliPath) && fs.existsSync(path.join(pkgRoot, 'viewer-dist', 'index.html'));

const FIXTURE = {
  formatVersion: 1,
  meta: {
    service: 'cli-smoke',
    capturedAt: new Date().toISOString(),
    wallAnchor: { wallMs: Date.now(), monoNs: '0' },
    trigger: { type: 'manual', reason: 'fixture' },
    eventCount: 1,
    windowMs: 10,
    flightboxVersion: '0.1.0'
  },
  events: [
    {
      seq: 0,
      wallMs: Date.now(),
      tMonoNs: '0',
      type: 'custom',
      requestId: 'orphan',
      spanId: '0',
      data: { name: 'fixture-event' }
    }
  ]
};

describe.skipIf(!hasBuild)('flightbox open (CLI smoke)', () => {
  it('serves the bundled viewer and the incident bytes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbox-cli-'));
    const fixturePath = path.join(dir, 'fixture.fbox');
    const fixtureBytes = gzipSync(JSON.stringify(FIXTURE));
    fs.writeFileSync(fixturePath, fixtureBytes);

    const child = spawn(
      process.execPath,
      [cliPath, 'open', fixturePath, '--no-open', '--port', '0'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI never printed a URL')), 10_000);
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const m = /http:\/\/localhost:\d+\/\?src=[^\s]+/.exec(out);
          if (m) {
            clearTimeout(timer);
            resolve(m[0]);
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`CLI exited early with code ${code}`));
        });
      });

      const parsed = new URL(url);
      const origin = parsed.origin;
      const incidentPath = parsed.searchParams.get('src')!;
      expect(incidentPath).toMatch(/^\/__incident-[0-9a-f]{32}$/);

      const incidentRes = await fetch(`${origin}${incidentPath}`);
      expect(incidentRes.status).toBe(200);
      expect(Buffer.from(await incidentRes.arrayBuffer()).equals(fixtureBytes)).toBe(true);

      const indexRes = await fetch(`${origin}/`);
      expect(indexRes.status).toBe(200);
      expect(await indexRes.text()).toContain('<div id="root">');

      // Path traversal stays inside viewer-dist.
      const evil = await fetch(`${origin}/../package.json`);
      expect(evil.status).toBe(404);

      // The bare legacy path is gone (unguessable path is the contract now).
      const legacy = await fetch(`${origin}/__incident`);
      expect(legacy.status).toBe(404);

      // DNS-rebinding guard: a non-localhost Host header is refused.
      const port = Number(parsed.port);
      const rebound = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: incidentPath, headers: { host: 'evil.example' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on('error', reject);
      });
      expect(rebound).toBe(403);
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
