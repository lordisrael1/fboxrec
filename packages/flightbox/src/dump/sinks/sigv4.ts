import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature V4 — Bible §6: S3 (and R2/B2/MinIO) is just HTTP + this
 * signing math. ~120 lines of node:crypto + fetch instead of tens of MB of
 * @aws-sdk. Session tokens supported for the ADR 017 credential chain.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAtMs?: number;
  /** Which chain link produced these (static | aws-env | ecs-task-role | ec2-imdsv2). */
  source?: string;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** AWS uriEncode: RFC3986, unreserved A-Za-z0-9 - . _ ~, optional '/' passthrough. */
export function uriEncode(str: string, encodeSlash: boolean): string {
  let out = '';
  for (const ch of str) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (ch === '/' && !encodeSlash)) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

function timestamps(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function canonicalUri(url: URL): string {
  return (
    url.pathname
      .split('/')
      .map((seg) => uriEncode(safeDecode(seg), true))
      .join('/') || '/'
  );
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Code-point order, NOT localeCompare — AWS canonicalization is byte order,
 * and after uriEncode every string is pure ASCII, where the two coincide. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalQuery(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)] as const)
    .sort((a, b) => (a[0] === b[0] ? byCodePoint(a[1], b[1]) : byCodePoint(a[0], b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}

export interface SignHeadersInput {
  method: string;
  url: URL;
  payloadHash: string;
  creds: AwsCredentials;
  region: string;
  service?: string;
  headers?: Record<string, string>;
  now?: Date;
}

/** Header-signed request (PUT uploads). Returns the complete header set. */
export function signHeaders(input: SignHeadersInput): Record<string, string> {
  const service = input.service ?? 's3';
  const { amzDate, dateStamp } = timestamps(input.now ?? new Date());

  const headers: Record<string, string> = {
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
    ...(input.creds.sessionToken ? { 'x-amz-security-token': input.creds.sessionToken } : {}),
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    )
  };

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url),
    canonicalQuery([...input.url.searchParams.entries()]),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest)
  ].join('\n');

  const signature = createHmac(
    'sha256',
    signingKey(input.creds.secretAccessKey, dateStamp, input.region, service)
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

export interface PresignInput {
  url: URL;
  creds: AwsCredentials;
  region: string;
  expiresSec: number;
  method?: string;
  service?: string;
  now?: Date;
}

/** Presigned GET — the same signature math expressed as query params. */
export function presignUrl(input: PresignInput): string {
  const service = input.service ?? 's3';
  const method = input.method ?? 'GET';
  const { amzDate, dateStamp } = timestamps(input.now ?? new Date());
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;

  const params: Array<[string, string]> = [
    ...input.url.searchParams.entries(),
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.creds.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(Math.floor(input.expiresSec))],
    ['X-Amz-SignedHeaders', 'host']
  ];
  if (input.creds.sessionToken) {
    params.push(['X-Amz-Security-Token', input.creds.sessionToken]);
  }

  const query = canonicalQuery(params);
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(input.url),
    query,
    `host:${input.url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD'
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest)
  ].join('\n');

  const signature = createHmac(
    'sha256',
    signingKey(input.creds.secretAccessKey, dateStamp, input.region, service)
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  return `${input.url.origin}${canonicalUri(input.url)}?${query}&X-Amz-Signature=${signature}`;
}
