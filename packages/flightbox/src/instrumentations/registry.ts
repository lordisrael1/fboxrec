import type { AgentApi } from '../agent';
import { instrumentHttpServer, restoreHttpServer } from './http-server';
import { instrumentHttpClient, restoreHttpClient } from './http-client';
import { instrumentPg, restorePg } from './pg';
import { instrumentConsole, restoreConsole } from './console';

/**
 * Applies every instrumentation, each individually try/caught — a failed
 * patch degrades to "that signal isn't recorded", never to a broken app.
 * Returning false means the target module isn't installed (not an error).
 */
const INSTRUMENTATIONS: ReadonlyArray<
  readonly [string, (agent: AgentApi) => boolean | void]
> = [
  ['http-server', instrumentHttpServer],
  ['http-client', instrumentHttpClient],
  ['pg', instrumentPg],
  ['console', instrumentConsole]
];

export function applyInstrumentations(agent: AgentApi): void {
  for (const [name, apply] of INSTRUMENTATIONS) {
    try {
      if (apply(agent) === false) {
        agent.config.log(`instrumentation ${name}: module not present, skipped`);
      }
    } catch (err) {
      agent.config.log(`instrumentation ${name} failed to apply: ${(err as Error).message}`);
    }
  }
}

const RESTORATIONS: ReadonlyArray<readonly [string, () => void]> = [
  ['http-server', restoreHttpServer],
  ['http-client', restoreHttpClient],
  ['pg', restorePg],
  ['console', restoreConsole]
];

/**
 * Reverses applyInstrumentations. Each restore unwraps its target only if
 * our wrapper is still on top; a target that other tooling wrapped after us
 * keeps its chain, and our buried wrapper degrades to a pass-through until
 * the next start().
 */
export function removeInstrumentations(log: (msg: string) => void): void {
  for (const [name, restore] of RESTORATIONS) {
    try {
      restore();
    } catch (err) {
      log(`instrumentation ${name} failed to restore: ${(err as Error).message}`);
    }
  }
}
