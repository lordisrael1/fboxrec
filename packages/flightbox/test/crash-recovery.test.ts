import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Staging } from '../src/dump/stage';
import { recoverPanicFiles } from '../src/dump/panic';

/**
 * Bible Week 2 milestone: "stage→recovery loop tested with killed child
 * processes." A real child process starts the BUILT agent, throws an
 * uncaught exception, and dies; a fresh "process" (new Staging in this
 * test) adopts and recovers the incident.
 *
 * Requires dist/ (pnpm build) — CI builds before testing; skipped otherwise.
 */

const distPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/index.cjs'
);
const hasDist = fs.existsSync(distPath);
const LIMITS = { maxStageMb: 500, minDiskFreePct: 0 };
const silent = (): void => {};

describe.skipIf(!hasDist)('crash → die → recover across real processes', () => {
  it('recovers an uncaughtException dump from a dead child', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbox-crash-'));
    const script = `
      const flightbox = require(${JSON.stringify(distPath)});
      flightbox.start({ dir: ${JSON.stringify(dir)}, bufferMb: 1, service: 'child-svc', log: () => {} });
      flightbox.addEvent('pre-crash-marker', { n: 1 });
      setTimeout(() => { throw new Error('child exploded on purpose'); }, 50);
    `;
    const out = spawnSync(process.execPath, ['-e', script], { timeout: 20_000 });
    expect(out.status).not.toBe(0); // crash semantics preserved (monitor, not handler)

    // "Next boot": a different process adopts the dead child's staging dir.
    const staging = new Staging(dir, LIMITS, silent);
    expect(staging.claimOrphanedSync()).toBeGreaterThan(0);
    recoverPanicFiles(staging, 'child-svc', silent);

    const files = staging.listStagedSync();
    expect(files.length).toBeGreaterThan(0);
    const incident = JSON.parse(gunzipSync(fs.readFileSync(files[0]!)).toString('utf8'));
    expect(incident.meta.trigger.type).toBe('uncaughtException');
    expect(incident.meta.trigger.reason).toContain('child exploded');
    expect(
      incident.events.some(
        (e: any) => e.type === 'custom' && e.data.name === 'pre-crash-marker'
      )
    ).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recovers a manually staged incident from a child killed before delivery', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbox-kill-'));
    const script = `
      const flightbox = require(${JSON.stringify(distPath)});
      flightbox.start({
        dir: ${JSON.stringify(dir)}, bufferMb: 1, service: 'child-svc', log: () => {},
        // Sink that can never deliver: the file must stay safe in staging.
        sinks: [{ type: 'http', url: 'http://127.0.0.1:1/blackhole' }]
      });
      flightbox.addEvent('work', { step: 1 });
      const staged = flightbox.trigger('before the kill');
      if (!staged) process.exit(3);
      process.kill(process.pid); // die mid-delivery
    `;
    const out = spawnSync(process.execPath, ['-e', script], { timeout: 20_000 });
    expect(out.status).not.toBe(0);

    const staging = new Staging(dir, LIMITS, silent);
    expect(staging.claimOrphanedSync()).toBeGreaterThan(0);
    const files = staging.listStagedSync();
    expect(files.length).toBeGreaterThan(0);
    const incident = JSON.parse(gunzipSync(fs.readFileSync(files[0]!)).toString('utf8'));
    expect(incident.meta.trigger.reason).toBe('before the kill');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
