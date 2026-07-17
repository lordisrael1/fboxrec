import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DiskSinkConfig } from '../../config';
import type { Sink, DeliveryResult } from './types';

/**
 * Copy into a configured dir. On EC2/VPS this alone is a complete solution.
 * The target dir is quota-bound like staging (ADR 006 / audit L6): oldest
 * .fbox files are FIFO-evicted so the sink can never fill the disk either.
 */
export function createDiskSink(cfg: DiskSinkConfig): Sink {
  const maxBytes = (cfg.maxMb ?? 500) * 1024 * 1024;
  return {
    name: 'disk',
    async deliver(filePath): Promise<DeliveryResult> {
      const dir = path.resolve(cfg.dir);
      await fs.promises.mkdir(dir, { recursive: true });
      const dest = path.join(dir, path.basename(filePath));
      await fs.promises.copyFile(filePath, dest);
      evictOverQuota(dir, maxBytes);
      return { ok: true, location: dest };
    }
  };
}

function evictOverQuota(dir: string, maxBytes: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.fbox'))
      .sort() // names embed timestamps: lexicographic = oldest first
      .map((f) => path.join(dir, f));
    let total = 0;
    const sized = files.map((file) => {
      const size = fs.statSync(file).size;
      total += size;
      return { file, size };
    });
    for (const { file, size } of sized) {
      if (total <= maxBytes) break;
      fs.unlinkSync(file);
      total -= size;
    }
  } catch {
    // Eviction is best-effort; delivery already succeeded.
  }
}
