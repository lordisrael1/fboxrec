import { formatWithOptions } from 'node:util';
import type { AgentApi } from '../agent';
import { EventType, truncate, LIMITS } from '../encoder';
import { capScrub } from '../redaction';
import { isShedding } from '../load-shedding';

/**
 * Console passthrough capture: every console.* line lands on the timeline
 * (redacted, truncated at 1KB) and still reaches stdout/stderr untouched.
 * The agent's own diagnostics use process.stderr.write directly, so there
 * is no recursion.
 */

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Bound the inspection work, not just the output length (audit L7):
 * console.log(hugeObject) must not pay full serialization on the hot path. */
const FORMAT_OPTS = { depth: 2, maxArrayLength: 20, maxStringLength: LIMITS.log } as const;

let patched = false;
let agentRef: AgentApi;

export function instrumentConsole(agent: AgentApi): void {
  agentRef = agent;
  if (patched) return;
  patched = true;

  for (const level of LEVELS) {
    const orig = console[level].bind(console);
    console[level] = function flightboxConsole(...args: unknown[]): void {
      try {
        if (!isShedding()) {
          const msg = capScrub(formatWithOptions(FORMAT_OPTS, ...args), LIMITS.log);
          agentRef.recorder.record(EventType.Log, { level, msg });
        }
      } catch {
        // Never break the host's logging.
      }
      orig(...args);
    };
  }
}
