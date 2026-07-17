import * as fs from 'node:fs';
import type { HttpSinkConfig } from '../../config';
import type { Sink, DeliveryResult } from './types';

const MAX_ATTEMPTS = 3;
const POST_TIMEOUT_MS = 30_000;

/**
 * POST the gzipped incident to any URL — an internal endpoint, a
 * Slack-forwarding lambda, someday a collector. 3 attempts with backoff;
 * on final failure the file simply stays in staging for the next boot's
 * recovery pass. Nothing is ever lost silently.
 */
export function createHttpSink(cfg: HttpSinkConfig): Sink {
  return {
    name: 'http',
    async deliver(filePath, meta): Promise<DeliveryResult> {
      const body = await fs.promises.readFile(filePath);
      // Header values must be single-line.
      const metaHeader = JSON.stringify(meta).replace(/[\r\n]/g, ' ');

      let lastDetail = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        }
        try {
          const res = await fetch(cfg.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/gzip',
              'x-flightbox-meta': metaHeader,
              ...cfg.headers
            },
            body,
            // A stuck connection must never hang delivery forever.
            signal: AbortSignal.timeout(POST_TIMEOUT_MS)
          });
          if (res.ok) return { ok: true, location: cfg.url };
          lastDetail = `HTTP ${res.status}`;
          // 4xx (except 408/429) won't improve with retries.
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            break;
          }
        } catch (err) {
          lastDetail = (err as Error).message;
        }
      }
      return { ok: false, detail: `${lastDetail} after retries — file kept in staging` };
    }
  };
}
