import type { AgentApi } from '../agent';

/**
 * Slow-request trigger, both halves per Bible §7:
 *  - at req end: http-server instrumentation calls maybeFireSlow() with the
 *    measured duration
 *  - in-flight watchdog: a 1s unref'd sweep catches HUNG requests that will
 *    never reach 'finish' — the case the end-hook can't see.
 */

interface InFlight {
  method: string;
  path: string;
  startedAtMs: number;
  fired: boolean;
}

const inFlight = new Map<bigint, InFlight>();

export function trackRequestStart(requestId: bigint, method: string, path: string): void {
  inFlight.set(requestId, { method, path, startedAtMs: Date.now(), fired: false });
}

export function trackRequestEnd(requestId: bigint): void {
  inFlight.delete(requestId);
}

export function maybeFireSlow(agent: AgentApi, method: string, path: string, durMs: number): void {
  if (durMs > agent.config.triggers.slowRequestMs) {
    agent.fire({
      type: 'slowRequest',
      reason: `${method} ${path} took ${durMs.toFixed(0)}ms (threshold ${agent.config.triggers.slowRequestMs}ms)`
    });
  }
}

export function startWatchdog(agent: AgentApi): () => void {
  const interval = setInterval(() => {
    try {
      const now = Date.now();
      const threshold = agent.config.triggers.slowRequestMs;
      for (const entry of inFlight.values()) {
        if (!entry.fired && now - entry.startedAtMs > threshold) {
          entry.fired = true; // one firing per hung request
          agent.fire({
            type: 'slowRequest',
            reason: `${entry.method} ${entry.path} still in flight after ${(now - entry.startedAtMs).toFixed(0)}ms (watchdog)`
          });
        }
      }
    } catch {
      // Watchdog must never throw.
    }
  }, 1000);
  interval.unref();
  return () => {
    clearInterval(interval);
    inFlight.clear();
  };
}
