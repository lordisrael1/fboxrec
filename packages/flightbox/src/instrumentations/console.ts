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

type Level = (typeof LEVELS)[number];
type ConsoleFn = (...args: unknown[]) => void;

let agentRef: AgentApi;
/** false after stop(): wrappers still in a chain pass straight through. */
let active = false;
/** One entry per level whose chain still contains our wrapper. */
const patches = new Map<Level, { orig: ConsoleFn; wrapper: ConsoleFn }>();

export function instrumentConsole(agent: AgentApi): void {
  agentRef = agent;
  active = true;

  for (const level of LEVELS) {
    if (patches.has(level)) continue; // wrapper survives from a previous start
    const orig = console[level] as ConsoleFn;
    const bound = orig.bind(console);
    const wrapper = function flightboxConsole(...args: unknown[]): void {
      try {
        if (active && !isShedding()) {
          const msg = capScrub(formatWithOptions(FORMAT_OPTS, ...args), LIMITS.log);
          agentRef.recorder.record(EventType.Log, { level, msg });
        }
      } catch {
        // Never break the host's logging.
      }
      bound(...args);
    };
    patches.set(level, { orig, wrapper });
    console[level] = wrapper;
  }
}

/**
 * Reverses instrumentConsole. A level that other tooling wrapped after us
 * keeps its chain (removing it would strip their patch too); our buried
 * wrapper passes through until the next start().
 */
export function restoreConsole(): void {
  active = false;
  for (const [level, p] of patches) {
    if (console[level] === p.wrapper) {
      console[level] = p.orig;
      patches.delete(level);
    }
  }
}
