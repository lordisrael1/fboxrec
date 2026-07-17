import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as v8 from 'node:v8';
import type { AgentApi } from '../agent';
import { EventType } from '../encoder';
import { isShedding, setShedding } from '../load-shedding';

/**
 * 100ms vitals sampler (unref'd — never keeps the process alive):
 *  - records event-loop lag + memory as timeline events (they keep recording
 *    even during shedding: vitals ARE the degraded mode's signal)
 *  - is the ADR 012 shedding SENSOR: shed above lagMs, resume below half
 *    (hysteresis), transitions recorded as events
 *  - hosts the memory trigger (heap vs V8 limit) and event-loop-stall trigger
 */

export function startVitals(agent: AgentApi): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const { shedLagMs } = agent.config.shedding;
  const { heapPct, stallMs } = agent.config.triggers;
  const heapLimit = v8.getHeapStatistics().heap_size_limit;

  // Edge-triggered with hysteresis (audit L1): sustained pressure fires the
  // trigger ONCE per excursion instead of every 100ms sample — otherwise the
  // ring fills with suppressed-trigger markers during the exact window
  // someone will want to inspect.
  let memAbove = false;
  let stallAbove = false;

  const interval = setInterval(() => {
    try {
      const lagMs = histogram.mean / 1e6;
      const maxLagMs = histogram.max / 1e6;
      histogram.reset();
      const mem = process.memoryUsage();

      agent.recorder.record(EventType.Vitals, {
        lagMs: Math.round(lagMs * 1000) / 1000,
        maxLagMs: Math.round(maxLagMs * 1000) / 1000,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss
      });

      // ADR 012 — adaptive load-shedding with hysteresis.
      if (!isShedding() && lagMs > shedLagMs) {
        setShedding(true);
        agent.recorder.record(EventType.Custom, {
          name: 'flightbox.shedding',
          on: true,
          lagMs: Math.round(lagMs)
        });
        agent.config.log(
          `event-loop lag ${lagMs.toFixed(0)}ms > ${shedLagMs}ms — load-shedding ON (ADR 012)`
        );
      } else if (isShedding() && lagMs < shedLagMs / 2) {
        setShedding(false);
        agent.recorder.record(EventType.Custom, {
          name: 'flightbox.shedding',
          on: false,
          lagMs: Math.round(lagMs)
        });
        agent.config.log('event-loop lag recovered — load-shedding OFF');
      }

      // Memory trigger (Bible §7) — once per excursion above the threshold.
      const heapFrac = mem.heapUsed / heapLimit;
      if (heapFrac > heapPct && !memAbove) {
        memAbove = true;
        agent.fire({
          type: 'memory',
          reason: `heapUsed at ${(heapFrac * 100).toFixed(0)}% of V8 limit`
        });
      } else if (memAbove && heapFrac < heapPct * 0.9) {
        memAbove = false;
      }

      // Event-loop stall trigger (Bible §7) — once per excursion.
      if (maxLagMs > stallMs && !stallAbove) {
        stallAbove = true;
        agent.fire({
          type: 'eventloop-stall',
          reason: `event loop stalled ${maxLagMs.toFixed(0)}ms (threshold ${stallMs}ms)`
        });
      } else if (stallAbove && maxLagMs < stallMs / 2) {
        stallAbove = false;
      }
    } catch {
      // The sampler must never take the process down.
    }
  }, 100);
  interval.unref();

  return () => {
    clearInterval(interval);
    histogram.disable();
  };
}
