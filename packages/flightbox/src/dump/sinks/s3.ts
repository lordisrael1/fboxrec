import * as fs from 'node:fs';
import * as path from 'node:path';

const PUT_TIMEOUT_MS = 30_000;
import type { S3SinkConfig } from '../../config';
import type { Sink, DeliveryResult } from './types';
import { sha256Hex, signHeaders, presignUrl } from './sigv4';
import { resolveCredentials, invalidateCredentials } from './credentials';

const MAX_PRESIGN_SEC = 7 * 24 * 3600; // SigV4 hard limit

/**
 * The S3/R2/B2/MinIO sink — Bible §4.3/§6. Uploads via header-signed PUT;
 * mints the presigned magic link (ADR 008: viewer origin configurable for
 * air-gapped/self-hosted viewers). A 403 invalidates the ADR 017 credential
 * cache and retries once with fresh credentials (rotation race).
 */
export function createS3Sink(cfg: S3SinkConfig, defaultViewerOrigin: string): Sink {
  const region = cfg.region || (cfg.endpoint ? 'auto' : 'us-east-1');

  function objectUrl(key: string): URL {
    if (cfg.endpoint) {
      // Path-style for custom endpoints (R2/B2/MinIO).
      return new URL(`${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}/${key}`);
    }
    return new URL(`https://${cfg.bucket}.s3.${region}.amazonaws.com/${key}`);
  }

  return {
    name: 's3',
    async deliver(filePath, meta): Promise<DeliveryResult> {
      // Async read — delivery happens while the server may be unhealthy;
      // don't add synchronous file I/O to the event loop on top of that.
      const body = await fs.promises.readFile(filePath);
      const key = `${cfg.prefix ?? ''}${path.basename(filePath)}`;

      let creds = await resolveCredentials(cfg);
      if (!creds) {
        return {
          ok: false,
          detail:
            'no AWS credentials resolved (chain: static -> AWS_* env -> ECS task role -> IMDSv2)'
        };
      }

      const put = async (c: typeof creds & object): Promise<Response> => {
        const url = objectUrl(key);
        const headers = signHeaders({
          method: 'PUT',
          url,
          payloadHash: sha256Hex(body),
          creds: c,
          region,
          headers: {
            'content-type': 'application/gzip',
            'x-amz-meta-flightbox-trigger': meta.trigger.type
          }
        });
        return fetch(url, {
          method: 'PUT',
          headers,
          body,
          // A hung connection must not leave the delivery promise pending
          // forever; the file stays staged and the retry pass gets it.
          signal: AbortSignal.timeout(PUT_TIMEOUT_MS)
        });
      };

      let res = await put(creds);
      if (res.status === 403) {
        // Rotation race (ADR 017): refresh once and retry.
        invalidateCredentials();
        const fresh = await resolveCredentials(cfg);
        if (fresh) {
          creds = fresh;
          res = await put(fresh);
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, detail: `S3 PUT ${res.status}: ${text.slice(0, 200)}` };
      }

      const location = `s3://${cfg.bucket}/${key}`;
      let viewerUrl: string | undefined;
      if (cfg.presign?.enabled !== false) {
        // 24h default (audit L4): the link is printed to logs, which makes
        // log access a bearer credential for the incident — keep it short.
        const expiresSec = Math.min(
          (cfg.presign?.expiresHours ?? 24) * 3600,
          MAX_PRESIGN_SEC
        );
        const presigned = presignUrl({ url: objectUrl(key), creds, region, expiresSec });
        const origin = (cfg.presign?.viewerOrigin ?? defaultViewerOrigin).replace(/\/$/, '');
        viewerUrl = `${origin}/?src=${encodeURIComponent(presigned)}`;
      }
      return { ok: true, location, viewerUrl };
    }
  };
}
