import type { AgentApi } from '../agent';
import { instrumentHttpServer } from './http-server';
import { instrumentHttpClient } from './http-client';
import { instrumentPg } from './pg';
import { instrumentConsole } from './console';

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
