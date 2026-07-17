import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StagingConfig } from '../config';

/**
 * Staging directory — every dump lands here FIRST, via synchronous write
 * (the only I/O survivable on the crash path). Sinks deliver from staging;
 * anything undelivered is recovered on next boot.
 *
 * ADR 006: staging is quota-bound (FIFO eviction of oldest .fbox) and the
 * disk is health-checked before every write so Flightbox can never fill a
 * production disk (self-inflicted DoS).
 *
 * ADR 010: each process stages into its own `staging/pid-<pid>/` dir so
 * cluster workers never collide; dead workers' dirs are adopted atomically
 * on boot via renameSync (exactly one claimant can win).
 */

export class DiskFullError extends Error {
  constructor(freePct: number, minFreePct: number) {
    super(
      `disk has ${freePct.toFixed(1)}% free, below the ${minFreePct}% safety floor`
    );
    this.name = 'DiskFullError';
  }
}

const PID_DIR_RE = /^pid-(\d+)$/;
/** A dir mid-adoption: claimed-<claimantPid>-<originalName>. */
const CLAIMED_DIR_RE = /^claimed-(\d+)-(.+)$/;

export class Staging {
  /** Shared root: <dir>/staging/ */
  readonly baseStagingDir: string;
  /** This process's isolated dir: <dir>/staging/pid-<pid>/ (ADR 010). */
  readonly stagingDir: string;
  readonly deliveredDir: string;

  constructor(
    baseDir: string,
    private readonly limits: StagingConfig,
    private readonly log: (msg: string) => void = () => {}
  ) {
    this.baseStagingDir = path.join(baseDir, 'staging');
    this.stagingDir = path.join(this.baseStagingDir, `pid-${process.pid}`);
    this.deliveredDir = path.join(baseDir, 'delivered');
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.deliveredDir, { recursive: true });
  }

  /**
   * Synchronous, crash-safe write: tmp file + fsync + rename (+ best-effort
   * parent-dir fsync on POSIX), so staging never holds a torn .fbox and a
   * power loss right after return cannot un-persist it. Throws
   * DiskFullError when the disk is critically full — the caller must
   * disable the agent (ADR 006) — and rejects any single dump larger than
   * the quota outright: "evict everything, then write the oversized file
   * anyway" would make the cap a fiction.
   */
  stageSync(fileName: string, data: Buffer): string {
    const maxBytes = this.limits.maxStageMb * 1024 * 1024;
    if (data.length > maxBytes) {
      throw new Error(
        `dump is ${(data.length / 1048576).toFixed(1)}MB, larger than the ` +
          `${this.limits.maxStageMb}MB staging quota — refusing to stage it`
      );
    }
    const freePct = this.diskFreePct();
    if (freePct !== null && freePct < this.limits.minDiskFreePct) {
      throw new DiskFullError(freePct, this.limits.minDiskFreePct);
    }
    this.evictOverQuota(data.length);
    const finalPath = path.join(this.stagingDir, fileName);
    const tmpPath = finalPath + '.part';
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, finalPath);
    try {
      // Durability for the rename itself. Windows cannot open directories
      // as fds — there the rename journal has to be enough.
      const dirFd = fs.openSync(this.stagingDir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch {
      /* best-effort on platforms that support it */
    }
    return finalPath;
  }

  /** Own staged .fbox files, oldest first (names embed timestamps). */
  listStagedSync(): string[] {
    return this.listOwn('.fbox');
  }

  /** Own raw panic dumps awaiting conversion (ADR 009). */
  listPanicSync(): string[] {
    return this.listOwn('.fboxpanic');
  }

  /**
   * Move a staged file to delivered/ after successful sink delivery.
   * delivered/ shares the ADR 006 quota — local retention must not outlive
   * the disk either.
   */
  markDeliveredSync(filePath: string): string {
    let incoming = 0;
    try {
      incoming = fs.statSync(filePath).size;
    } catch {
      // Missing source will fail the rename below; quota pass is best-effort.
    }
    this.evictFilesOverQuota(this.listDir(this.deliveredDir, '.fbox'), incoming);
    const dest = path.join(this.deliveredDir, path.basename(filePath));
    fs.renameSync(filePath, dest);
    return dest;
  }

  /**
   * ADR 010 adoption pass: absorb staging dirs left by DEAD sibling
   * processes. renameSync is the atomicity lock — when several new workers
   * race for the same orphan, exactly one rename succeeds; losers get
   * ENOENT and move on. Also re-adopts `claimed-*` dirs whose claimant died
   * mid-adoption (audit M4) — without this, a crash between the claim
   * rename and the file moves would strand incidents invisibly forever.
   * Returns how many files were adopted.
   *
   * Known limitation (audit L2): PID reuse. If a dead worker's pid was
   * recycled by an unrelated live process, its dir looks "alive" and waits
   * until that process exits. Solving this needs process identity beyond
   * the pid (start-time comparison), which has no portable API — accepted
   * for v0.1; the files are preserved, only delayed.
   */
  claimOrphanedSync(): number {
    let adopted = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(this.baseStagingDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      let ownerPid: number;
      let originalName = entry;
      const orphan = PID_DIR_RE.exec(entry);
      const halfClaimed = orphan ? null : CLAIMED_DIR_RE.exec(entry);
      if (orphan) {
        ownerPid = Number(orphan[1]);
      } else if (halfClaimed) {
        ownerPid = Number(halfClaimed[1]); // the claimant that died mid-adoption
        originalName = halfClaimed[2]!;
      } else {
        continue;
      }
      if (ownerPid === process.pid || isProcessAlive(ownerPid)) continue;

      const orphanDir = path.join(this.baseStagingDir, entry);
      // Re-claims keep the ORIGINAL name segment so the claimant-pid prefix
      // never nests (claimed-B-claimed-A-pid-N would hide A's death).
      const claimedDir = path.join(this.baseStagingDir, `claimed-${process.pid}-${originalName}`);
      try {
        fs.renameSync(orphanDir, claimedDir); // the lock: one winner only
      } catch {
        continue; // another worker won the race, or the dir vanished
      }
      try {
        for (const file of fs.readdirSync(claimedDir)) {
          if (!file.endsWith('.fbox') && !file.endsWith('.fboxpanic')) {
            try {
              fs.unlinkSync(path.join(claimedDir, file)); // stray .part etc.
            } catch {
              /* best-effort */
            }
            continue;
          }
          try {
            fs.renameSync(path.join(claimedDir, file), path.join(this.stagingDir, file));
            adopted++;
          } catch {
            /* best-effort; leave in claimed dir for a later pass */
          }
        }
        fs.rmdirSync(claimedDir);
      } catch {
        /* partial adoption is fine; remainder is picked up next boot */
      }
    }
    if (adopted > 0) {
      this.log(`adopted ${adopted} file(s) from dead worker staging dirs`);
    }
    return adopted;
  }

  private listOwn(ext: string): string[] {
    return this.listDir(this.stagingDir, ext);
  }

  private listDir(dir: string, ext: string): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .sort()
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  /** null = cannot determine (treat as healthy rather than disable the agent). */
  private diskFreePct(): number | null {
    const statfsSync: ((p: string) => { bavail: number | bigint; blocks: number | bigint }) | undefined =
      (fs as unknown as Record<string, any>).statfsSync;
    if (typeof statfsSync !== 'function') return null;
    try {
      const s = statfsSync(this.stagingDir);
      const blocks = Number(s.blocks);
      if (!Number.isFinite(blocks) || blocks <= 0) return null;
      return (Number(s.bavail) / blocks) * 100;
    } catch {
      return null;
    }
  }

  /** ADR 006 FIFO eviction: silently drop oldest staged dumps to fit the quota. */
  private evictOverQuota(incomingBytes: number): void {
    this.evictFilesOverQuota(this.listStagedSync(), incomingBytes);
  }

  private evictFilesOverQuota(candidates: string[], incomingBytes: number): void {
    const maxBytes = this.limits.maxStageMb * 1024 * 1024;
    const files: Array<{ file: string; size: number }> = [];
    let total = incomingBytes;
    for (const file of candidates) {
      try {
        const size = fs.statSync(file).size;
        files.push({ file, size });
        total += size;
      } catch {
        // File vanished between listing and stat — ignore.
      }
    }
    for (const { file, size } of files) {
      if (total <= maxBytes) break;
      try {
        fs.unlinkSync(file);
        total -= size;
        this.log(`staging quota (${this.limits.maxStageMb}MB) exceeded — evicted oldest: ${path.basename(file)}`);
      } catch {
        // Eviction is best-effort; never let it break the dump path.
      }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Boot-time resurrection pass: adopt dead siblings' staging (ADR 010), then
 * report (and later, deliver) anything staged but undelivered. Sinks land in
 * a later milestone; until then files are preserved and announced.
 */
export function recoverOnBoot(staging: Staging, log: (msg: string) => void): string[] {
  staging.claimOrphanedSync();
  const files = staging.listStagedSync();
  if (files.length > 0) {
    log(
      `found ${files.length} unsent incident(s) from a previous run in ${staging.stagingDir}`
    );
  }
  return files;
}
