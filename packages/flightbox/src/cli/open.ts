import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { presignUrl } from '../dump/sinks/sigv4';
import { resolveCredentials } from '../dump/sinks/credentials';

/**
 * `npx fboxrec open <source>` — serves the BUNDLED viewer (the same Vite
 * build as viewer.flightbox.dev) from localhost and injects the incident at
 * /__incident. Fully offline; works over SSH tunnels.
 *
 * ADR 008: <source> may be a local file, an s3://bucket/key (downloaded
 * server-side with this machine's credentials/network position — air-gapped
 * VPCs never need a public bucket), or any https:// URL.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function viewerDistDir(): string {
  // dist/cli/main.cjs -> ../../viewer-dist (inside the npm tarball).
  return path.resolve(__dirname, '..', '..', 'viewer-dist');
}

async function fetchS3(source: string): Promise<Buffer> {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(source);
  if (!m) throw new Error(`invalid s3 url: ${source}`);
  const [, bucket, key] = m;
  const creds = await resolveCredentials({});
  if (!creds) {
    throw new Error(
      'no AWS credentials found (chain: FLIGHTBOX_S3_KEY/SECRET -> AWS_* env -> ECS -> IMDSv2)'
    );
  }
  const endpoint = process.env.FLIGHTBOX_S3_ENDPOINT?.replace(/\/$/, '');
  const region = process.env.FLIGHTBOX_S3_REGION || (endpoint ? 'auto' : 'us-east-1');
  const url = endpoint
    ? new URL(`${endpoint}/${bucket}/${key}`)
    : new URL(`https://${bucket}.s3.${region}.amazonaws.com/${key}`);
  const presigned = presignUrl({ url, creds, region, expiresSec: 300 });
  return fetchCapped(presigned);
}

/** Incident files are ring-buffer-sized; anything bigger is not a dump. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

async function fetchCapped(url: string): Promise<Buffer> {
  // This runs on the operator's machine with their credentials and network
  // position — a timeout and size cap keep a bad/malicious URL from
  // hanging the CLI or exhausting the disk/RAM.
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) {
    throw new Error(`remote file is ${len} bytes — larger than any plausible incident`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`remote file exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
  }
  return buf;
}

async function loadSource(source: string): Promise<{ data: Buffer; label: string }> {
  if (source.startsWith('s3://')) {
    return { data: await fetchS3(source), label: source };
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return { data: await fetchCapped(source), label: source };
  }
  return { data: fs.readFileSync(source), label: path.resolve(source) };
}

export interface OpenOptions {
  port?: number;
  openBrowser?: boolean;
}

export async function openCommand(source: string, opts: OpenOptions = {}): Promise<http.Server> {
  const dist = viewerDistDir();
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error(
      `bundled viewer not found at ${dist} — this build of flightbox was packaged without it (run: pnpm build)`
    );
  }
  const { data, label } = await loadSource(source);
  // Unguessable path (audit M5, defense in depth vs. DNS rebinding).
  const incidentPath = `/__incident-${randomBytes(16).toString('hex')}`;

  const server = http.createServer((req, res) => {
    // Audit M5: a malicious site can DNS-rebind its hostname to 127.0.0.1
    // and read this server same-origin — the Host header is the tell.
    // Browsers always send it; only localhost forms are legitimate here.
    const host = String(req.headers.host ?? '');
    const hostname = host.replace(/:\d+$/, '');
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') {
      res.writeHead(403).end('forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === incidentPath) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': data.length
      });
      res.end(data);
      return;
    }
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(dist, path.normalize(rel));
    if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream'
    });
    res.end(fs.readFileSync(file));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 4560, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const viewerUrl = `http://localhost:${port}/?src=${encodeURIComponent(incidentPath)}`;

  process.stderr.write(`flightbox: serving ${label}\n`);
  process.stdout.write(`${viewerUrl}\n`);

  if (opts.openBrowser !== false) {
    const cmd =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', viewerUrl]]
        : process.platform === 'darwin'
          ? ['open', [viewerUrl]]
          : ['xdg-open', [viewerUrl]];
    try {
      spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // Printing the URL is enough.
    }
  }
  return server;
}
