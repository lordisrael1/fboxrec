import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Staging } from '../src/dump/stage';

const LIMITS = { maxStageMb: 500, minDiskFreePct: 0 };
const silent = (): void => {};

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fbox-stage-'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('Staging', () => {
  it('stages into a pid-isolated dir (ADR 010) and lists/delivers', () => {
    const staging = new Staging(base, LIMITS, silent);
    expect(staging.stagingDir).toContain(`pid-${process.pid}`);

    const staged = staging.stageSync('incident-a.fbox', Buffer.from('data-a'));
    expect(fs.readFileSync(staged).toString()).toBe('data-a');
    expect(staging.listStagedSync()).toEqual([staged]);
    // No torn .part files left behind.
    expect(fs.readdirSync(staging.stagingDir).some((f) => f.endsWith('.part'))).toBe(false);

    const delivered = staging.markDeliveredSync(staged);
    expect(fs.existsSync(delivered)).toBe(true);
    expect(staging.listStagedSync()).toEqual([]);
  });

  it('FIFO-evicts oldest staged files over the quota (ADR 006)', () => {
    // ~2KB quota; three 1KB files can never coexist.
    const staging = new Staging(base, { maxStageMb: 2 / 1024, minDiskFreePct: 0 }, silent);
    const kb = Buffer.alloc(1024, 1);
    staging.stageSync('incident-1.fbox', kb);
    staging.stageSync('incident-2.fbox', kb);
    staging.stageSync('incident-3.fbox', kb);

    const names = staging.listStagedSync().map((f) => path.basename(f));
    expect(names).not.toContain('incident-1.fbox');
    expect(names).toContain('incident-3.fbox');
  });

  it('refuses a single dump larger than the quota — the cap is HARD (audit)', () => {
    // 1MB quota, 2MB dump: eviction can never make room, so writing it
    // anyway would blow the cap. It must throw, not stage.
    const staging = new Staging(base, { maxStageMb: 1, minDiskFreePct: 0 }, silent);
    const twoMb = Buffer.alloc(2 * 1024 * 1024, 7);
    expect(() => staging.stageSync('incident-huge.fbox', twoMb)).toThrow(/larger than/);
    expect(staging.listStagedSync()).toEqual([]);
    // A stray .part must not survive the rejection.
    expect(fs.readdirSync(staging.stagingDir).some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('adopts staging dirs of dead workers, atomically (ADR 010)', () => {
    // A process that has already exited = guaranteed-dead pid.
    const dead = spawnSync(process.execPath, ['-e', '']);
    const deadPid = dead.pid!;
    expect(deadPid).toBeGreaterThan(0);

    const deadDir = path.join(base, 'staging', `pid-${deadPid}`);
    fs.mkdirSync(deadDir, { recursive: true });
    fs.writeFileSync(path.join(deadDir, 'incident-dead.fbox'), Buffer.from('orphan'));
    fs.writeFileSync(path.join(deadDir, 'leftover.part'), Buffer.from('torn'));

    const staging = new Staging(base, LIMITS, silent);
    expect(staging.claimOrphanedSync()).toBe(1);
    expect(staging.listStagedSync().map((f) => path.basename(f))).toContain(
      'incident-dead.fbox'
    );
    expect(fs.existsSync(deadDir)).toBe(false);
  });

  it('re-adopts claimed-* dirs stranded by a claimant that died mid-adoption (audit M4)', () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    const deadPid = dead.pid!;

    // A previous worker (now dead) renamed pid-N to claimed-<deadPid>-pid-N
    // and crashed before moving the files out.
    const strandedDir = path.join(base, 'staging', `claimed-${deadPid}-pid-424242`);
    fs.mkdirSync(strandedDir, { recursive: true });
    fs.writeFileSync(path.join(strandedDir, 'incident-stranded.fbox'), Buffer.from('stranded'));

    const staging = new Staging(base, LIMITS, silent);
    expect(staging.claimOrphanedSync()).toBe(1);
    expect(staging.listStagedSync().map((f) => path.basename(f))).toContain(
      'incident-stranded.fbox'
    );
    expect(fs.existsSync(strandedDir)).toBe(false);
  });

  it('leaves claimed-* dirs of LIVE claimants alone (adoption in progress)', () => {
    const inProgress = path.join(base, 'staging', `claimed-${process.ppid}-pid-424242`);
    fs.mkdirSync(inProgress, { recursive: true });
    fs.writeFileSync(path.join(inProgress, 'incident-busy.fbox'), Buffer.from('busy'));

    const staging = new Staging(base, LIMITS, silent);
    expect(staging.claimOrphanedSync()).toBe(0);
    expect(fs.existsSync(path.join(inProgress, 'incident-busy.fbox'))).toBe(true);
  });

  it('never touches a live process’s staging dir (ADR 010)', () => {
    // ppid = the vitest runner — alive for the duration of this test.
    const liveDir = path.join(base, 'staging', `pid-${process.ppid}`);
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'incident-live.fbox'), Buffer.from('live'));

    const staging = new Staging(base, LIMITS, silent);
    expect(staging.claimOrphanedSync()).toBe(0);
    expect(fs.existsSync(path.join(liveDir, 'incident-live.fbox'))).toBe(true);
  });
});
