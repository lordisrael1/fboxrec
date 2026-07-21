import { isMainThread } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { IncidentMeta } from '@flightbox/format';
import { resolveConfig, type UserConfig, type FlightboxConfig } from './config';
import { anchorClock } from './clock';
import { RingBuffer } from './ring-buffer';
import { Recorder } from './recorder';
import { EventType, truncate, LIMITS } from './encoder';
import { setShedding } from './load-shedding';
import type { AgentApi } from './agent';
import { Staging, DiskFullError, recoverOnBoot } from './dump/stage';
import { PanicWriter, recoverPanicFiles } from './dump/panic';
import { buildIncident, DUMP_GZIP_LEVEL } from './dump/serializer';
import { takeFrozenSnapshot } from './dump/snapshot';
import { createSink, type Sink } from './dump/sinks';
import { TriggerEngine, type TriggerFireInfo } from './triggers/engine';
import { createManualTrigger } from './triggers/manual';
import { installCrashTriggers } from './triggers/uncaught';
import { startWatchdog } from './triggers/slow-request';
import { applyInstrumentations, removeInstrumentations } from './instrumentations/registry';
import { startVitals } from './instrumentations/vitals';

export type { UserConfig, FlightboxConfig, SinkConfig } from './config';

interface Instance {
  config: FlightboxConfig;
  recorder: Recorder;
  staging: Staging;
  engine: TriggerEngine;
  panicWriter: PanicWriter;
  sinks: Sink[];
  manualTrigger: (reason?: string) => string | null;
  teardowns: Array<() => void>;
  /** Files currently being delivered — the retry pass must not double-send. */
  deliveryInFlight: Set<string>;
}

/** Staged-but-undelivered incidents are retried on a timer, not only on
 * restart — a healthy long-running process must self-heal after a
 * transient sink outage. */
const SINK_RETRY_INTERVAL_MS = 5 * 60_000;

/** Memory-pressure dumps swap in this small ring instead of a full-size
 * allocation (see Recorder.freezeAndSwap). */
const EMERGENCY_RING_BYTES = 4 * 1024 * 1024;

let instance: Instance | null = null;

/**
 * Arms the flight recorder: allocates the ring buffer, applies
 * instrumentations, installs triggers/vitals, runs the boot-time recovery
 * pass, and starts delivering anything a previous run left behind.
 * Idempotent.
 */
export function start(userConfig: UserConfig = {}): void {
  if (instance) return;
  const config = resolveConfig(userConfig);
  if (!isMainThread && !config.allowWorkerThreads) {
    // ADR 014: prevent N-worker x 64MB silent memory multiplication.
    config.log(
      'worker thread detected — agent not started (each thread would allocate its own ring buffer; see ADR 014). Set allowWorkerThreads: true to record in this thread anyway.'
    );
    return;
  }
  anchorClock();

  const recorder = new Recorder(new RingBuffer(config.bufferMb * 1024 * 1024));
  const staging = new Staging(config.dir, config.staging, config.log);
  // Resurrection order matters: adopt dead workers' dirs (ADR 010), convert
  // any raw panic dumps to .fbox (ADR 009), THEN announce unsent incidents.
  staging.claimOrphanedSync();
  recoverPanicFiles(staging, config.service, config.log);
  const unsent = recoverOnBoot(staging, config.log);
  // Preallocate the OOM panic fd while memory is plentiful (ADR 009).
  const panicWriter = new PanicWriter(staging.stagingDir);
  panicWriter.arm();

  const sinks = config.sinks.map((cfg) => createSink(cfg, config.viewerOrigin));

  const engine = new TriggerEngine(
    config.triggers.cooldownMs,
    (info) => dump(info),
    (info) =>
      recorder.record(EventType.Trigger, {
        suppressed: true,
        triggerType: info.type,
        reason: info.reason
      })
  );

  const agent: AgentApi = {
    recorder,
    config,
    fire: (info) => engine.fire(info)
  };

  instance = {
    config,
    recorder,
    staging,
    engine,
    panicWriter,
    sinks,
    manualTrigger: createManualTrigger(engine),
    teardowns: [],
    deliveryInFlight: new Set()
  };

  applyInstrumentations(agent);
  instance.teardowns.push(startWatchdog(agent));
  instance.teardowns.push(startVitals(agent));
  instance.teardowns.push(
    installCrashTriggers({
      agent,
      // Crash dumps bypass the routine cooldown (a slow-request dump minutes
      // ago must never cost us the final-moments dump); the engine's short
      // crash window still collapses rejection→rethrow→uncaught to one file.
      syncDump: (info) => engine.fire({ ...info, mode: 'sync', exemptFromCooldown: true }),
      panicDump: () => panicWriter.writeSync(recorder.activeRing)
    })
  );

  recorder.armed = true;
  config.log(
    `armed — ${config.bufferMb}MB ring buffer, staging at ${staging.stagingDir}` +
      (sinks.length ? `, sinks: ${sinks.map((s) => s.name).join('+')}` : ', no sinks (staging only)')
  );

  // Boot-time delivery of what previous runs never managed to send.
  if (sinks.length > 0 && unsent.length > 0) {
    void deliverRecovered(instance, unsent);
  }

  // Periodic retry: transient sink failures heal without a restart.
  if (sinks.length > 0) {
    const inst = instance;
    const retry = setInterval(() => void retryStaged(inst), SINK_RETRY_INTERVAL_MS);
    retry.unref();
    instance.teardowns.push(() => clearInterval(retry));
  }
}

async function retryStaged(inst: Instance): Promise<void> {
  try {
    for (const file of inst.staging.listStagedSync()) {
      if (inst.deliveryInFlight.has(file)) continue;
      const meta = readMetaSync(file);
      if (!meta) continue;
      inst.config.log(`retrying delivery of ${path.basename(file)}...`);
      await deliverFile(inst, file, meta);
    }
  } catch {
    // The retry pass itself must never take the process down.
  }
}

function readMetaSync(filePath: string): IncidentMeta | null {
  try {
    const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8'));
    return parsed?.meta ?? null;
  } catch {
    return null;
  }
}

async function deliverRecovered(inst: Instance, files: string[]): Promise<void> {
  for (const file of files) {
    const meta = readMetaSync(file);
    if (!meta) continue;
    inst.config.log(`delivering recovered incident ${path.basename(file)}...`);
    await deliverFile(inst, file, meta);
  }
}

async function deliverFile(inst: Instance, filePath: string, meta: IncidentMeta): Promise<void> {
  if (inst.sinks.length === 0 || inst.deliveryInFlight.has(filePath)) return;
  inst.deliveryInFlight.add(filePath);
  try {
    await deliverFileInner(inst, filePath, meta);
  } finally {
    inst.deliveryInFlight.delete(filePath);
  }
}

async function deliverFileInner(
  inst: Instance,
  filePath: string,
  meta: IncidentMeta
): Promise<void> {
  let allOk = true;
  let viewerUrl: string | undefined;
  for (const sink of inst.sinks) {
    try {
      const result = await sink.deliver(filePath, meta);
      if (result.ok) {
        if (result.location) inst.config.log(`   stored:  ${result.location}`);
        viewerUrl ??= result.viewerUrl;
      } else {
        allOk = false;
        inst.config.log(`   sink ${sink.name} failed: ${result.detail ?? 'unknown error'}`);
      }
    } catch (err) {
      allOk = false;
      inst.config.log(`   sink ${sink.name} threw: ${(err as Error).message}`);
    }
  }
  if (viewerUrl) inst.config.log(`   open:    ${viewerUrl}`);
  if (allOk) {
    try {
      inst.staging.markDeliveredSync(filePath);
    } catch {
      // Retention move is best-effort; the data is already delivered.
    }
  }
  // Failures leave the file in staging for the next boot's recovery pass.
}

/**
 * The dump. `mode: 'sync'` (manual + crash paths) compresses on-thread with
 * gzipSync; the default async mode (live triggers under load) runs gzip on
 * the libuv threadpool so compression never blocks the event loop (ADR 016).
 * Either way the buffer was already frozen-and-swapped (ADR 005).
 */
function dump(info: TriggerFireInfo): string | null {
  const inst = instance;
  if (!inst) return null;

  // The trigger marker rides inside the incident itself.
  inst.recorder.record(EventType.Trigger, {
    triggerType: info.type,
    reason: info.reason
  });

  // Memory-pressure dumps must not allocate another full ring at the worst
  // possible moment — swap in a small emergency ring instead. The next
  // normal dump restores full capture size.
  const replacement = info.type === 'memory' ? EMERGENCY_RING_BYTES : undefined;
  if (replacement) {
    inst.config.log(
      `memory trigger: recording continues in a ${EMERGENCY_RING_BYTES / 1048576}MB emergency ring until pressure clears`
    );
  }
  const events = takeFrozenSnapshot(inst.recorder, replacement);
  const prepared = buildIncident({
    service: inst.config.service,
    trigger: { type: info.type, reason: info.reason },
    events
  });

  const finalize = (data: Buffer): string | null => {
    let stagedPath: string;
    try {
      stagedPath = inst.staging.stageSync(prepared.fileName, data);
    } catch (err) {
      if (err instanceof DiskFullError) {
        // ADR 006: a debugging tool must never DoS its host.
        inst.recorder.armed = false;
        inst.config.log(`DISK CRITICAL — ${err.message}. Agent disabled.`);
        return null;
      }
      inst.config.log(`failed to stage incident: ${(err as Error).message}`);
      return null;
    }
    inst.config.log(
      `🔴 incident captured (${(data.length / 1024).toFixed(1)} KB gz, ${prepared.eventCount} events, ${(prepared.windowMs / 1000).toFixed(1)}s window)`
    );
    inst.config.log(`   trigger: ${info.type}${info.reason ? ` — ${info.reason}` : ''}`);
    inst.config.log(`   staged:  ${stagedPath}`);
    void deliverFile(inst, stagedPath, prepared.meta);
    return stagedPath;
  };

  if (info.mode === 'sync') {
    return finalize(zlib.gzipSync(prepared.json, { level: DUMP_GZIP_LEVEL }));
  }

  // ADR 016: compression on the libuv threadpool, off the event loop.
  const prospectivePath = path.join(inst.staging.stagingDir, prepared.fileName);
  zlib.gzip(prepared.json, { level: DUMP_GZIP_LEVEL }, (err, data) => {
    if (err) {
      inst.config.log(`gzip failed for ${prepared.fileName}: ${err.message}`);
      return;
    }
    finalize(data);
  });
  return prospectivePath;
}

/** Manually capture an incident. Returns the staged file path, or null (cooldown / not started / disk guard). */
export function trigger(reason?: string): string | null {
  return instance ? instance.manualTrigger(reason) : null;
}

/** Record a custom timeline event (e.g. flightbox.addEvent('cache.miss', { key })). */
export function addEvent(name: string, data: Record<string, unknown> = {}): void {
  instance?.recorder.record(EventType.Custom, {
    name: truncate(name, LIMITS.path),
    ...data
  });
}

/**
 * Disarms recording: stops samplers/watchdogs/timers, removes the process
 * listeners, and restores the module patches (console, http server/client,
 * fetch, pg). A patch that other tooling wrapped after start() can't be
 * spliced out safely; it stays in place but passes straight through.
 * start() may be called again afterwards.
 */
export function stop(): void {
  if (instance) {
    instance.recorder.armed = false;
    for (const teardown of instance.teardowns) {
      try {
        teardown();
      } catch {
        /* best-effort */
      }
    }
    removeInstrumentations(instance.config.log);
    instance.panicWriter.disarm();
    setShedding(false);
    instance = null;
  }
}

export default { start, stop, trigger, addEvent };
