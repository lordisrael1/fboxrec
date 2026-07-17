import * as v8 from 'node:v8';
import type { AgentApi } from '../agent';
import { EventType, truncate } from '../encoder';
import { capScrub } from '../redaction';

/**
 * Crash triggers — Bible §7 + ADR 009.
 *
 * uncaughtException uses 'uncaughtExceptionMonitor': it observes without
 * changing crash semantics (the process still dies exactly as it would
 * have). unhandledRejection records + dumps, then RETHROWS the reason to
 * preserve default crash behavior — but ONLY when Flightbox is the sole
 * listener. If the app installed its own unhandledRejection handler (the
 * log-and-survive pattern), rethrowing would force-crash a process that
 * intended to live AND preempt the app's handler; in that case we record
 * only and let the app decide. The count is checked at emit time, not
 * install time. The resulting uncaughtException dump (sole-listener case)
 * is deduped by the engine's crash cooldown.
 *
 * ADR 009 escalation: when the heap is nearly exhausted (the OOM case),
 * gzip/decode would abort V8 — the crash dump degrades to the raw panic
 * write on the preopened fd instead.
 */

export const OOM_HEAP_FRACTION = 0.94;

export interface CrashDeps {
  agent: AgentApi;
  /** Normal path: synchronous serialize + stage (fast gzip). */
  syncDump(info: { type: string; reason?: string }): string | null;
  /** ADR 009 path: raw ring bytes on the preopened fd. */
  panicDump(): boolean;
}

function nearHeapLimit(): boolean {
  try {
    const stats = v8.getHeapStatistics();
    return stats.used_heap_size / stats.heap_size_limit > OOM_HEAP_FRACTION;
  } catch {
    return false;
  }
}

export function crashDump(deps: CrashDeps, type: string, err: unknown): void {
  const message = capScrub(String((err as Error)?.message ?? err), 512);
  try {
    deps.agent.recorder.record(EventType.Custom, {
      name: type,
      message,
      stack: capScrub(String((err as Error)?.stack ?? ''), 2048)
    });
  } catch {
    // Even the marker is best-effort at crash time.
  }

  if (nearHeapLimit()) {
    // ADR 009: no allocation-heavy work near the heap limit.
    const ok = deps.panicDump();
    deps.agent.config.log(
      ok
        ? `OOM panic path: raw ring dumped; will be converted to .fbox on next boot`
        : `OOM panic path unavailable (no preopened fd)`
    );
    return;
  }
  deps.syncDump({ type, reason: message });
}

export function installCrashTriggers(deps: CrashDeps): () => void {
  const onUncaught = (err: unknown): void => {
    try {
      crashDump(deps, 'uncaughtException', err);
    } catch {
      // Never interfere with the crash itself.
    }
  };
  const onRejection = (reason: unknown): void => {
    try {
      crashDump(deps, 'unhandledRejection', reason);
    } catch {
      // Fall through regardless.
    }
    // Preserve default semantics (an unhandled rejection kills the process)
    // ONLY when no app handler exists — never override the app's decision.
    if (process.listenerCount('unhandledRejection') === 1) {
      throw reason;
    }
  };

  process.on('uncaughtExceptionMonitor', onUncaught);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.removeListener('uncaughtExceptionMonitor', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
  };
}
