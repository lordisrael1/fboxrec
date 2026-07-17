import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveConfig, type S3SinkConfig } from '../config';
import { sha256Hex, signHeaders, presignUrl } from '../dump/sinks/sigv4';
import { resolveCredentials } from '../dump/sinks/credentials';

/**
 * `npx fboxrec doctor` — verifies config, staging, credentials, sink
 * connectivity, and the ONE papercut that costs everyone 20 minutes: bucket
 * CORS for the magic link (prints the copy-paste fix when missing).
 */

let failures = 0;
function ok(msg: string): void {
  process.stdout.write(`  ✓ ${msg}\n`);
}
function warn(msg: string): void {
  process.stdout.write(`  ! ${msg}\n`);
}
function fail(msg: string): void {
  failures++;
  process.stdout.write(`  ✗ ${msg}\n`);
}

const CORS_FIX = (origin: string): string =>
  JSON.stringify(
    [
      {
        AllowedOrigins: [origin],
        AllowedMethods: ['GET'],
        AllowedHeaders: ['*'],
        MaxAgeSeconds: 3600
      }
    ],
    null,
    2
  );

export async function doctorCommand(): Promise<number> {
  process.stdout.write('flightbox doctor\n\n');

  // Node version.
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok(`node ${process.versions.node} (>= 18)`);
  else fail(`node ${process.versions.node} — flightbox needs >= 18 (global fetch, stable ALS)`);

  // Config resolution from env.
  let config;
  try {
    config = resolveConfig();
    ok(
      `config: service=${config.service}, bufferMb=${config.bufferMb}, dir=${config.dir}, ` +
        `slowMs=${config.triggers.slowRequestMs}, sinks=[${config.sinks.map((s) => s.type).join(', ') || 'none'}]`
    );
  } catch (err) {
    fail(`config invalid: ${(err as Error).message}`);
    return 1;
  }

  // Staging writable.
  try {
    const probe = path.join(config.dir, 'staging', `doctor-${process.pid}.probe`);
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    ok(`staging dir writable: ${path.join(config.dir, 'staging')}`);
  } catch (err) {
    fail(`staging dir not writable: ${(err as Error).message}`);
  }

  // Disk headroom.
  const statfsSync = (fs as any).statfsSync;
  if (typeof statfsSync === 'function') {
    try {
      const s = statfsSync(config.dir);
      const freePct = (Number(s.bavail) / Number(s.blocks)) * 100;
      if (freePct >= config.staging.minDiskFreePct) {
        ok(`disk ${freePct.toFixed(1)}% free (floor: ${config.staging.minDiskFreePct}%)`);
      } else {
        fail(`disk only ${freePct.toFixed(1)}% free — below the ${config.staging.minDiskFreePct}% floor; the agent would disable itself (ADR 006)`);
      }
    } catch {
      warn('could not stat disk free space');
    }
  }

  if (!config.token) {
    warn('FLIGHTBOX_TOKEN not set — the manual HTTP dump endpoint is disarmed');
  } else {
    ok('manual dump endpoint armed (/__flightbox/dump)');
  }

  // S3 sink end-to-end.
  const s3 = config.sinks.find((s): s is S3SinkConfig => s.type === 's3');
  if (!s3) {
    warn('no s3 sink configured — on ephemeral platforms (Render/Railway/Heroku) crash dumps need one (§5)');
  } else {
    await checkS3(s3, config.viewerOrigin);
  }

  process.stdout.write(failures === 0 ? '\nall clear ✈\n' : `\n${failures} problem(s) found\n`);
  return failures === 0 ? 0 : 1;
}

async function checkS3(s3: S3SinkConfig, viewerOrigin: string): Promise<void> {
  const creds = await resolveCredentials(s3);
  if (!creds) {
    fail('S3 credentials: none resolved (chain: static -> AWS_* env -> ECS task role -> IMDSv2)');
    return;
  }
  ok(
    `S3 credentials via ${creds.source}` +
      (creds.expiresAtMs ? ` (expire ${new Date(creds.expiresAtMs).toISOString()})` : '')
  );

  // This is a MUTATING check: it PUTs then DELETEs a probe object, so it
  // needs write + delete permission and a failure mid-run can leave the
  // probe behind. Say so — "doctor" shouldn't sound purely read-only.
  warn(
    'S3 check writes and deletes a probe object (needs PutObject + DeleteObject); ' +
      'a mid-run failure may leave one doctor-probe-*.txt behind'
  );
  const region = s3.region || (s3.endpoint ? 'auto' : 'us-east-1');
  const key = `${s3.prefix ?? ''}doctor-probe-${Date.now()}.txt`;
  const objectUrl = s3.endpoint
    ? new URL(`${s3.endpoint.replace(/\/$/, '')}/${s3.bucket}/${key}`)
    : new URL(`https://${s3.bucket}.s3.${region}.amazonaws.com/${key}`);

  // PUT probe.
  const body = Buffer.from('flightbox doctor probe');
  try {
    const headers = signHeaders({
      method: 'PUT',
      url: objectUrl,
      payloadHash: sha256Hex(body),
      creds,
      region
    });
    const res = await fetch(objectUrl, { method: 'PUT', headers, body });
    if (res.ok) ok(`S3 PUT s3://${s3.bucket}/${key}`);
    else {
      fail(`S3 PUT failed: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      return;
    }
  } catch (err) {
    fail(`S3 unreachable: ${(err as Error).message}`);
    return;
  }

  // Presigned GET probe.
  const presigned = presignUrl({ url: objectUrl, creds, region, expiresSec: 300 });
  try {
    const res = await fetch(presigned);
    if (res.ok && Buffer.from(await res.arrayBuffer()).equals(body)) {
      ok('presigned GET round-trips (magic links will work)');
    } else {
      fail(`presigned GET failed: HTTP ${res.status}`);
    }
  } catch (err) {
    fail(`presigned GET failed: ${(err as Error).message}`);
  }

  // CORS preflight probe — the #1 papercut (§4.4).
  const origin = s3.presign?.viewerOrigin ?? viewerOrigin;
  try {
    const res = await fetch(presigned, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' }
    });
    const allowed = res.headers.get('access-control-allow-origin');
    if (allowed === '*' || allowed === origin) {
      ok(`bucket CORS allows ${origin}`);
    } else {
      fail(
        `bucket CORS does NOT allow ${origin} — magic links will fail in the browser.\n` +
          `    Fix (AWS: bucket → Permissions → CORS; R2: bucket → Settings → CORS policy):\n` +
          CORS_FIX(origin)
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n')
      );
    }
  } catch {
    warn('could not probe CORS (endpoint rejected OPTIONS) — verify manually');
  }

  // Cleanup.
  try {
    const headers = signHeaders({
      method: 'DELETE',
      url: objectUrl,
      payloadHash: sha256Hex(''),
      creds,
      region
    });
    await fetch(objectUrl, { method: 'DELETE', headers });
  } catch {
    /* probe object left behind; harmless */
  }
}
