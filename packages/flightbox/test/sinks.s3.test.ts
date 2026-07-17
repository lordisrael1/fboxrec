import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncidentMeta } from '@flightbox/format';
import { createS3Sink } from '../src/dump/sinks/s3';
import { sha256Hex, signHeaders, presignUrl } from '../src/dump/sinks/sigv4';
import { resolveCredentials, invalidateCredentials } from '../src/dump/sinks/credentials';

/**
 * Bible §6 promises the SigV4 client is tested against a real S3-compatible
 * verifier. This in-process server re-derives every signature server-side
 * with the shared secret — a wrong canonical request, tampered query param,
 * or bad payload hash produces 403, exactly like S3/MinIO.
 */

const CREDS = { accessKeyId: 'AKIATESTKEY', secretAccessKey: 'test-secret-123' };
const REGION = 'auto';
const store = new Map<string, Buffer>();

let server: http.Server;
let endpoint: string;

function parseAmzDate(compact: string): Date {
  return new Date(
    `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T` +
      `${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`
  );
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const payloadHash = String(req.headers['x-amz-content-sha256']);
      if (sha256Hex(body) !== payloadHash) {
        res.writeHead(400).end('payload hash mismatch');
        return;
      }
      const expected = signHeaders({
        method: 'PUT',
        url: new URL(url.origin + url.pathname),
        payloadHash,
        creds: CREDS,
        region: REGION,
        headers: {
          'content-type': String(req.headers['content-type']),
          'x-amz-meta-flightbox-trigger': String(req.headers['x-amz-meta-flightbox-trigger'])
        },
        now: parseAmzDate(String(req.headers['x-amz-date']))
      });
      if (expected.authorization !== req.headers.authorization) {
        res.writeHead(403).end('SignatureDoesNotMatch');
        return;
      }
      store.set(url.pathname, body);
      res.writeHead(200).end();
      return;
    }

    if (req.method === 'GET') {
      const q = url.searchParams;
      const scope = q.get('X-Amz-Credential')!.split('/');
      const expectedUrl = presignUrl({
        url: new URL(url.origin + url.pathname),
        creds: CREDS,
        region: scope[2]!,
        expiresSec: Number(q.get('X-Amz-Expires')),
        now: parseAmzDate(q.get('X-Amz-Date')!)
      });
      const expectedSig = new URL(expectedUrl).searchParams.get('X-Amz-Signature');
      if (q.get('X-Amz-Signature') !== expectedSig) {
        res.writeHead(403).end('SignatureDoesNotMatch');
        return;
      }
      const obj = store.get(url.pathname);
      if (!obj) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end(obj);
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const META = { trigger: { type: 'manual' } } as IncidentMeta;

describe('S3 sink — SigV4 against an in-process verifier', () => {
  let tmpFile: string;
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbox-s3-'));
    tmpFile = path.join(dir, 'incident-s3test.fbox');
    fs.writeFileSync(tmpFile, Buffer.from('pretend-gzipped-incident-bytes'));
  });

  it('uploads with a valid header signature and mints a working magic link', async () => {
    const sink = createS3Sink(
      {
        type: 's3',
        bucket: 'test-bucket',
        prefix: 'api/',
        endpoint,
        region: REGION,
        ...CREDS,
        presign: { enabled: true, expiresHours: 2, viewerOrigin: 'https://viewer.example' }
      },
      'https://viewer.flightbox.dev'
    );

    const result = await sink.deliver(tmpFile, META);
    expect(result.ok).toBe(true);
    expect(result.location).toBe('s3://test-bucket/api/incident-s3test.fbox');
    expect(result.viewerUrl).toMatch(/^https:\/\/viewer\.example\/\?src=/);

    // The magic link's presigned URL round-trips the exact bytes.
    const presigned = decodeURIComponent(result.viewerUrl!.split('?src=')[1]!);
    const res = await fetch(presigned);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(fs.readFileSync(tmpFile))).toBe(true);
  });

  it('rejects tampered presigned params (SigV4 integrity)', async () => {
    const presigned = presignUrl({
      url: new URL(`${endpoint}/test-bucket/api/incident-s3test.fbox`),
      creds: CREDS,
      region: REGION,
      expiresSec: 3600
    });
    const tampered = presigned.replace('X-Amz-Expires=3600', 'X-Amz-Expires=999999');
    expect((await fetch(tampered)).status).toBe(403);
  });

  it('fails cleanly with no credentials anywhere in the chain', async () => {
    invalidateCredentials();
    const saved = snapshotEnv();
    try {
      clearAwsEnv();
      const sink = createS3Sink(
        { type: 's3', bucket: 'b', endpoint, region: REGION },
        'https://viewer.flightbox.dev'
      );
      const result = await sink.deliver(tmpFile, META);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('no AWS credentials');
    } finally {
      restoreEnv(saved);
      invalidateCredentials();
    }
  });
});

const AWS_VARS = [
  'FLIGHTBOX_S3_KEY',
  'FLIGHTBOX_S3_SECRET',
  'FLIGHTBOX_S3_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT'
];
function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(AWS_VARS.map((k) => [k, process.env[k]]));
}
function clearAwsEnv(): void {
  for (const k of AWS_VARS) delete process.env[k];
}
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of AWS_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

describe('credential chain (ADR 017)', () => {
  let metaServer: http.Server;
  let metaBase: string;
  const expiration = new Date(Date.now() + 3600_000).toISOString();

  beforeAll(async () => {
    metaServer = http.createServer((req, res) => {
      if (req.method === 'PUT' && req.url === '/latest/api/token') {
        res.writeHead(200).end('imds-token-abc');
      } else if (req.url === '/latest/meta-data/iam/security-credentials/') {
        if (req.headers['x-aws-ec2-metadata-token'] !== 'imds-token-abc') {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200).end('my-instance-role');
      } else if (req.url === '/latest/meta-data/iam/security-credentials/my-instance-role') {
        res.writeHead(200).end(
          JSON.stringify({
            AccessKeyId: 'AKIDIMDS',
            SecretAccessKey: 'imds-secret',
            Token: 'imds-session',
            Expiration: expiration
          })
        );
      } else if (req.url === '/ecs-creds') {
        res.writeHead(200).end(
          JSON.stringify({
            AccessKeyId: 'AKIDECS',
            SecretAccessKey: 'ecs-secret',
            Token: 'ecs-session',
            Expiration: expiration
          })
        );
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => metaServer.listen(0, r));
    metaBase = `http://127.0.0.1:${(metaServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => metaServer.close(r));
  });

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = snapshotEnv();
    clearAwsEnv();
    invalidateCredentials();
    return () => {
      restoreEnv(saved);
      invalidateCredentials();
    };
  });

  it('resolves ECS/Fargate task-role credentials', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `${metaBase}/ecs-creds`;
    const creds = await resolveCredentials({});
    expect(creds?.source).toBe('ecs-task-role');
    expect(creds?.accessKeyId).toBe('AKIDECS');
    expect(creds?.sessionToken).toBe('ecs-session');
  });

  it('resolves EC2 instance-role credentials via IMDSv2 token flow', async () => {
    process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = metaBase;
    const creds = await resolveCredentials({});
    expect(creds?.source).toBe('ec2-imdsv2');
    expect(creds?.accessKeyId).toBe('AKIDIMDS');
    expect(creds?.sessionToken).toBe('imds-session');
  });

  it('static keys win over the metadata links', async () => {
    process.env.FLIGHTBOX_S3_KEY = 'AKIDSTATIC';
    process.env.FLIGHTBOX_S3_SECRET = 'static-secret';
    process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = metaBase;
    const creds = await resolveCredentials({});
    expect(creds?.source).toBe('static');
    expect(creds?.accessKeyId).toBe('AKIDSTATIC');
  });

  it('per-sink explicit credentials are NOT cross-contaminated by the cache (audit)', async () => {
    // Two sinks with different explicit keys must each get their OWN keys —
    // the global cache is only for the ambient (env/ECS/IMDS) chain.
    const a = await resolveCredentials({ accessKeyId: 'AKIDA', secretAccessKey: 'sa' });
    const b = await resolveCredentials({ accessKeyId: 'AKIDB', secretAccessKey: 'sb' });
    expect(a?.accessKeyId).toBe('AKIDA');
    expect(b?.accessKeyId).toBe('AKIDB');
  });

  it('explicit per-sink creds are never served the cached ambient identity (audit)', async () => {
    // Prime the shared cache with an IMDS identity...
    process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = metaBase;
    const ambient = await resolveCredentials({});
    expect(ambient?.source).toBe('ec2-imdsv2');
    // ...a sink with its own explicit keys must still get ITS keys.
    const explicit = await resolveCredentials({ accessKeyId: 'AKIDX', secretAccessKey: 'sx' });
    expect(explicit?.accessKeyId).toBe('AKIDX');
    expect(explicit?.source).toBe('static');
  });
});
