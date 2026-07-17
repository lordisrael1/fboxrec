import * as path from 'node:path';

export interface TriggersConfig {
  /** Requests slower than this fire the slow-request trigger (incl. watchdog). */
  slowRequestMs: number;
  /** One storm = one file: minimum time between dumps. */
  cooldownMs: number;
  /** Memory trigger: heapUsed fraction of the V8 limit. */
  heapPct: number;
  /** Event-loop stall trigger: max observed lag in one sample window. */
  stallMs: number;
}

export interface SheddingConfig {
  /** ADR 012: mean event-loop lag above this sheds per-request instrumentation. */
  shedLagMs: number;
}

export interface StagingConfig {
  /** ADR 006 — hard cap on staging/ size; oldest files FIFO-evicted over quota. */
  maxStageMb: number;
  /** ADR 006 — if the disk has less than this % free, the agent disables itself. */
  minDiskFreePct: number;
}

export interface S3SinkConfig {
  type: 's3';
  bucket: string;
  prefix?: string;
  /** Omit for AWS; set for R2/B2/MinIO (path-style is used when set). */
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  presign?: {
    enabled?: boolean;
    expiresHours?: number;
    /** ADR 008: self-hosted viewer origin for air-gapped environments. */
    viewerOrigin?: string;
  };
}

export interface DiskSinkConfig {
  type: 'disk';
  dir: string;
  /** Quota for the sink dir (FIFO eviction of oldest .fbox). Default 500. */
  maxMb?: number;
}

export interface HttpSinkConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type SinkConfig = S3SinkConfig | DiskSinkConfig | HttpSinkConfig;

export interface FlightboxConfig {
  service: string;
  /** Ring buffer size. The time window is a consequence of this and traffic. */
  bufferMb: number;
  /** Base directory holding staging/ and delivered/. */
  dir: string;
  triggers: TriggersConfig;
  staging: StagingConfig;
  shedding: SheddingConfig;
  /** Arms the manual dump endpoint (GET /__flightbox/dump, x-flightbox-token header). */
  token?: string;
  /** Default viewer origin for magic links (ADR 008). */
  viewerOrigin: string;
  sinks: SinkConfig[];
  /**
   * ADR 014: by default the agent refuses to start inside a worker thread —
   * N workers would allocate N rings (8 cores x 64MB = 512MB). Opt-in only.
   */
  allowWorkerThreads: boolean;
  /** Agent's own diagnostics channel. Defaults to stderr (console is captured). */
  log: (msg: string) => void;
}

export interface UserConfig {
  service?: string;
  bufferMb?: number;
  dir?: string;
  triggers?: Partial<TriggersConfig>;
  staging?: Partial<StagingConfig>;
  shedding?: Partial<SheddingConfig>;
  token?: string;
  viewerOrigin?: string;
  sinks?: SinkConfig[];
  allowWorkerThreads?: boolean;
  log?: (msg: string) => void;
}

const DEFAULTS = {
  bufferMb: 64,
  dir: '.flightbox',
  slowRequestMs: 5000,
  cooldownMs: 60_000,
  heapPct: 0.9,
  stallMs: 1000,
  shedLagMs: 50,
  maxStageMb: 500,
  minDiskFreePct: 5,
  viewerOrigin: 'https://viewer.flightbox.dev'
} as const;

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function envBool(name: string): boolean {
  return process.env[name] === '1' || process.env[name] === 'true';
}

/** §5: env-var-only S3 sink for platform users (Render/Railway/ECS...). */
function envS3Sink(): S3SinkConfig | null {
  const bucket = process.env.FLIGHTBOX_S3_BUCKET;
  if (!bucket) return null;
  return {
    type: 's3',
    bucket,
    prefix: process.env.FLIGHTBOX_S3_PREFIX ?? '',
    endpoint: process.env.FLIGHTBOX_S3_ENDPOINT,
    region: process.env.FLIGHTBOX_S3_REGION,
    presign: { enabled: true }
  };
}

/**
 * Fail loudly on a mistyped sink at start() rather than silently doing
 * nothing (or something surprising) when the first incident fires.
 */
function validateSink(sink: SinkConfig): void {
  switch (sink.type) {
    case 's3': {
      if (!sink.bucket || typeof sink.bucket !== 'string') {
        throw new Error('flightbox: s3 sink requires a non-empty "bucket"');
      }
      if (sink.endpoint !== undefined && !/^https?:\/\//.test(sink.endpoint)) {
        throw new Error(`flightbox: s3 sink "endpoint" must be an http(s) URL, got ${sink.endpoint}`);
      }
      if (sink.prefix !== undefined && typeof sink.prefix !== 'string') {
        throw new Error('flightbox: s3 sink "prefix" must be a string');
      }
      const hrs = sink.presign?.expiresHours;
      if (hrs !== undefined && (!Number.isFinite(hrs) || hrs <= 0 || hrs > 168)) {
        throw new Error(`flightbox: s3 presign.expiresHours must be in (0, 168], got ${hrs}`);
      }
      break;
    }
    case 'http': {
      if (!/^https?:\/\//.test(sink.url ?? '')) {
        throw new Error(`flightbox: http sink "url" must be an http(s) URL, got ${sink.url}`);
      }
      break;
    }
    case 'disk': {
      if (!sink.dir || typeof sink.dir !== 'string') {
        throw new Error('flightbox: disk sink requires a non-empty "dir"');
      }
      if (sink.maxMb !== undefined && (!Number.isFinite(sink.maxMb) || sink.maxMb < 1)) {
        throw new Error(`flightbox: disk sink "maxMb" must be >= 1, got ${sink.maxMb}`);
      }
      break;
    }
    default:
      throw new Error(`flightbox: unknown sink type "${(sink as { type: string }).type}"`);
  }
}

/**
 * Precedence: env vars > code config > defaults. Env-var-only setup is what
 * makes `node -r fboxrec/register server.js` work with zero code changes.
 */
export function resolveConfig(user: UserConfig = {}): FlightboxConfig {
  const bufferMb = envNumber('FLIGHTBOX_BUFFER_MB') ?? user.bufferMb ?? DEFAULTS.bufferMb;
  const dir = process.env.FLIGHTBOX_DIR || user.dir || DEFAULTS.dir;
  const service =
    process.env.FLIGHTBOX_SERVICE || user.service || path.basename(process.cwd());
  const slowRequestMs =
    envNumber('FLIGHTBOX_TRIGGER_SLOW_MS') ?? user.triggers?.slowRequestMs ?? DEFAULTS.slowRequestMs;
  const cooldownMs = user.triggers?.cooldownMs ?? DEFAULTS.cooldownMs;
  const heapPct =
    envNumber('FLIGHTBOX_TRIGGER_HEAP_PCT') ?? user.triggers?.heapPct ?? DEFAULTS.heapPct;
  const stallMs =
    envNumber('FLIGHTBOX_TRIGGER_STALL_MS') ?? user.triggers?.stallMs ?? DEFAULTS.stallMs;
  const shedLagMs =
    envNumber('FLIGHTBOX_SHED_LAG_MS') ?? user.shedding?.shedLagMs ?? DEFAULTS.shedLagMs;
  const maxStageMb =
    envNumber('FLIGHTBOX_MAX_STAGE_MB') ?? user.staging?.maxStageMb ?? DEFAULTS.maxStageMb;
  const minDiskFreePct = user.staging?.minDiskFreePct ?? DEFAULTS.minDiskFreePct;

  if (!Number.isFinite(bufferMb) || bufferMb < 1 || bufferMb > 4096) {
    throw new RangeError(`flightbox: bufferMb must be between 1 and 4096, got ${bufferMb}`);
  }
  if (!Number.isFinite(slowRequestMs) || slowRequestMs < 50) {
    throw new RangeError(`flightbox: triggers.slowRequestMs must be >= 50, got ${slowRequestMs}`);
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new RangeError(`flightbox: triggers.cooldownMs must be >= 0, got ${cooldownMs}`);
  }
  if (!Number.isFinite(heapPct) || heapPct <= 0 || heapPct >= 1) {
    throw new RangeError(`flightbox: triggers.heapPct must be in (0,1), got ${heapPct}`);
  }
  if (!Number.isFinite(stallMs) || stallMs < 50) {
    throw new RangeError(`flightbox: triggers.stallMs must be >= 50, got ${stallMs}`);
  }
  if (!Number.isFinite(shedLagMs) || shedLagMs < 1) {
    throw new RangeError(`flightbox: shedding.shedLagMs must be >= 1, got ${shedLagMs}`);
  }
  if (!Number.isFinite(maxStageMb) || maxStageMb < 1) {
    throw new RangeError(`flightbox: staging.maxStageMb must be >= 1, got ${maxStageMb}`);
  }
  if (!Number.isFinite(minDiskFreePct) || minDiskFreePct < 0 || minDiskFreePct > 50) {
    throw new RangeError(`flightbox: staging.minDiskFreePct must be 0-50, got ${minDiskFreePct}`);
  }

  const sinks: SinkConfig[] = [...(user.sinks ?? [])];
  const s3FromEnv = envS3Sink();
  if (s3FromEnv && !sinks.some((s) => s.type === 's3')) sinks.push(s3FromEnv);
  sinks.forEach(validateSink);

  return {
    service,
    bufferMb,
    dir: path.resolve(dir),
    triggers: { slowRequestMs, cooldownMs, heapPct, stallMs },
    staging: { maxStageMb, minDiskFreePct },
    shedding: { shedLagMs },
    token: process.env.FLIGHTBOX_TOKEN || user.token,
    viewerOrigin:
      process.env.FLIGHTBOX_VIEWER_ORIGIN || user.viewerOrigin || DEFAULTS.viewerOrigin,
    sinks,
    allowWorkerThreads: envBool('FLIGHTBOX_ALLOW_WORKER_THREADS') || (user.allowWorkerThreads ?? false),
    log: user.log ?? ((msg: string) => process.stderr.write(`flightbox: ${msg}\n`))
  };
}
