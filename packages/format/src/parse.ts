import { validateIncident } from './validate';
import type { Incident } from './types';

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/**
 * Untrusted-input limits: the viewer opens arbitrary dropped files and
 * remote URLs, so a crafted gzip bomb must fail with a message instead of
 * freezing the tab. Sized generously above any real ring dump.
 */
export const MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const MAX_EVENT_COUNT = 2_000_000;

/**
 * Gunzip that works in both browsers and Node >= 18 without importing any
 * Node built-in at module load (this file must stay browser-safe).
 *
 * Support matrix: browsers use DecompressionStream (Chrome/Edge 80+,
 * Firefox 113+, Safari 16.4+); Node (and older Node without the global)
 * falls back to node:zlib. A browser too old for DecompressionStream gets
 * an actionable error instead of a cryptic failed import of node:zlib.
 */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const g = globalThis as Record<string, any>;
  if (typeof g.DecompressionStream !== 'undefined') {
    // Streamed with a running total, so a decompression bomb aborts at the
    // cap instead of materializing gigabytes first.
    const reader = new g.Blob([bytes])
      .stream()
      .pipeThrough(new g.DecompressionStream('gzip'))
      .getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += (value as Uint8Array).length;
      if (total > MAX_DECOMPRESSED_BYTES) {
        void reader.cancel();
        throw new Error(
          `Refusing to decompress: file expands past ${MAX_DECOMPRESSED_BYTES} bytes — not a plausible incident.`
        );
      }
      chunks.push(value as Uint8Array);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  try {
    const zlib = await import('node:zlib');
    const out = new Uint8Array(
      zlib.gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
    );
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        `Refusing to decompress: file expands past ${MAX_DECOMPRESSED_BYTES} bytes — not a plausible incident.`
      );
    }
    if ((err as Error)?.message?.includes('output length')) {
      throw new Error(
        `Refusing to decompress: file expands past ${MAX_DECOMPRESSED_BYTES} bytes — not a plausible incident.`
      );
    }
    throw new Error(
      'This environment cannot decompress .fbox files: it has neither ' +
        'DecompressionStream (Chrome/Edge 80+, Firefox 113+, Safari 16.4+) ' +
        'nor working node:zlib. Use a newer browser, or `npx fboxrec open <file>`.'
    );
  }
}

/**
 * Parse .fbox bytes (gzipped JSON envelope), raw JSON bytes, or a JSON string
 * into a validated, typed Incident. Runs entirely in-process: in the browser
 * the file never leaves the machine.
 */
export async function parseIncident(
  input: Uint8Array | ArrayBuffer | string
): Promise<Incident> {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    let bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1) {
      bytes = await gunzip(bytes);
    }
    text = new TextDecoder('utf-8').decode(bytes);
  }

  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(
      'Not a Flightbox incident: file is neither gzipped JSON nor plain JSON.'
    );
  }
  validateIncident(obj);
  if (obj.events.length > MAX_EVENT_COUNT) {
    throw new Error(
      `Incident has ${obj.events.length} events — above the ${MAX_EVENT_COUNT} viewer limit.`
    );
  }
  return obj;
}
