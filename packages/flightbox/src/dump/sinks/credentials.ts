import type { AwsCredentials } from './sigv4';

/**
 * ADR 017 — credential provider chain for the zero-dependency S3 client.
 * Resolved in order, cached until ~5 minutes before expiry:
 *
 *   1. explicit config / FLIGHTBOX_S3_KEY + FLIGHTBOX_S3_SECRET (+_TOKEN)
 *   2. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+AWS_SESSION_TOKEN)
 *   3. ECS/Fargate task role (container credentials endpoint)
 *   4. EC2 instance role via IMDSv2 (token-required; v1 deliberately omitted)
 *
 * Metadata fetches use ~1s timeouts so non-AWS environments fail through
 * the chain instantly. Standard override env vars
 * (AWS_CONTAINER_CREDENTIALS_FULL_URI, AWS_EC2_METADATA_SERVICE_ENDPOINT)
 * are honored — which is also what makes this chain testable without AWS.
 */

const REFRESH_MARGIN_MS = 5 * 60_000;
const METADATA_TIMEOUT_MS = 1000;

let cache: AwsCredentials | null = null;

export function invalidateCredentials(): void {
  cache = null;
}

interface StaticCredsSource {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

function fromStatic(cfg: StaticCredsSource): AwsCredentials | null {
  const key = cfg.accessKeyId ?? process.env.FLIGHTBOX_S3_KEY;
  const secret = cfg.secretAccessKey ?? process.env.FLIGHTBOX_S3_SECRET;
  if (!key || !secret) return null;
  return {
    accessKeyId: key,
    secretAccessKey: secret,
    sessionToken: cfg.sessionToken ?? process.env.FLIGHTBOX_S3_TOKEN,
    source: 'static'
  };
}

function fromAwsEnv(): AwsCredentials | null {
  const key = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;
  if (!key || !secret) return null;
  return {
    accessKeyId: key,
    secretAccessKey: secret,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    source: 'aws-env'
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fromEcs(): Promise<AwsCredentials | null> {
  const fullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const relativeUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (!fullUri && !relativeUri) return null;
  const url = fullUri ?? `http://169.254.170.2${relativeUri}`;
  const body = await fetchJson(url);
  if (!body?.AccessKeyId || !body?.SecretAccessKey) return null;
  return {
    accessKeyId: body.AccessKeyId,
    secretAccessKey: body.SecretAccessKey,
    sessionToken: body.Token,
    expiresAtMs: body.Expiration ? Date.parse(body.Expiration) : undefined,
    source: 'ecs-task-role'
  };
}

async function fromImdsV2(): Promise<AwsCredentials | null> {
  const base =
    process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT?.replace(/\/$/, '') ??
    'http://169.254.169.254';
  let token: string;
  try {
    const res = await fetch(`${base}/latest/api/token`, {
      method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    token = await res.text();
  } catch {
    return null;
  }
  const tokenHeader = { 'x-aws-ec2-metadata-token': token };

  let role: string;
  try {
    const res = await fetch(`${base}/latest/meta-data/iam/security-credentials/`, {
      headers: tokenHeader,
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    role = (await res.text()).split('\n')[0]!.trim();
    if (!role) return null;
  } catch {
    return null;
  }

  const body = await fetchJson(
    `${base}/latest/meta-data/iam/security-credentials/${role}`,
    { headers: tokenHeader }
  );
  if (!body?.AccessKeyId || !body?.SecretAccessKey) return null;
  return {
    accessKeyId: body.AccessKeyId,
    secretAccessKey: body.SecretAccessKey,
    sessionToken: body.Token,
    expiresAtMs: body.Expiration ? Date.parse(body.Expiration) : undefined,
    source: 'ec2-imdsv2'
  };
}

export async function resolveCredentials(
  cfg: StaticCredsSource = {}
): Promise<AwsCredentials | null> {
  // Per-sink static credentials are cheap and sink-SPECIFIC — never cached
  // globally, or two sinks with different explicit keys would poison each
  // other (one sink's creds reused for the other's bucket). Only the
  // ambient identity chain (env/ECS/IMDS — same answer for every sink in
  // this process) goes through the shared cache.
  const staticCreds = fromStatic(cfg);
  if (staticCreds) return staticCreds;
  const envCreds = fromAwsEnv();
  if (envCreds) return envCreds;

  if (
    cache &&
    (cache.expiresAtMs === undefined || cache.expiresAtMs - Date.now() > REFRESH_MARGIN_MS)
  ) {
    return cache;
  }
  cache = (await fromEcs()) ?? (await fromImdsV2());
  return cache;
}
