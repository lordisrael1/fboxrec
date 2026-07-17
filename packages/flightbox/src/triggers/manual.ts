import type { TriggerEngine } from './engine';

/**
 * Manual trigger — powers flightbox.trigger(). The token-gated HTTP endpoint
 * variant arrives with the trigger milestone (Week 2).
 */
export function createManualTrigger(engine: TriggerEngine) {
  return (reason = 'manual trigger'): string | null =>
    // Sync mode: dev-invoked, must return a path to a file that exists.
    engine.fire({ type: 'manual', reason, mode: 'sync' });
}
