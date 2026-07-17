import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { AgentApi } from '../agent';
import { EventType, truncate, LIMITS } from '../encoder';
import { newSpanId, currentRequestId } from '../context';
import { nowMono } from '../clock';
import { isShedding } from '../load-shedding';
import { capScrub } from '../redaction';

/**
 * Instruments the `pg` driver if the host app has it installed:
 *  - Client.prototype.query — text (truncated 2KB) + param SHAPES, never values
 *  - Pool.prototype.connect — pool wait time, the demo's star witness
 *
 * The requestId is captured once at query start and stamped on both the
 * start and end events explicitly, so span pairing survives the ADR 004
 * context nullification at response finish.
 */

/** Resolve `pg` from the host application's node_modules, not ours. */
function loadPg(): any | null {
  try {
    const req = createRequire(path.join(process.cwd(), 'noop.js'));
    return req('pg');
  } catch {
    return null;
  }
}

/** ADR 007-aligned: parameter shapes only — values never enter the ring. */
function paramShapes(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values
    .slice(0, 32)
    .map((v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v));
}

let agentRef: AgentApi;

export function instrumentPg(agent: AgentApi): boolean {
  agentRef = agent;
  const recorder = {
    record: ((...args) => agentRef.recorder.record(...args)) as AgentApi['recorder']['record']
  };
  const pg = loadPg();
  if (!pg?.Client?.prototype?.query) return false;

  if (!(pg.Client.prototype.query as any).__flightbox) {
    const origQuery = pg.Client.prototype.query;

    const wrappedQuery = function (this: unknown, ...args: any[]): unknown {
      // ADR 012: shed path — run the query untouched.
      if (isShedding()) return origQuery.apply(this, args);
      let spanId = 0n;
      let requestId = 0n;
      let tStart = 0n;
      let recordedStart = false;
      try {
        const first = args[0];
        const text = typeof first === 'string' ? first : first?.text;
        const values = Array.isArray(args[1])
          ? args[1]
          : Array.isArray(first?.values)
            ? first.values
            : undefined;
        spanId = newSpanId();
        requestId = currentRequestId();
        tStart = nowMono();
        recorder.record(
          EventType.PgQueryStart,
          {
            text: capScrub(typeof text === 'string' ? text : '<unknown>', LIMITS.query),
            params: paramShapes(values)
          },
          { spanId, requestId, tMonoNs: tStart }
        );
        recordedStart = true;
      } catch {
        // Fall through — the query itself must always run.
      }

      const done = (err?: unknown): void => {
        if (!recordedStart) return;
        try {
          const payload: Record<string, unknown> = {
            durMs: Number(nowMono() - tStart) / 1e6
          };
          if (err) {
            payload.error = truncate(String((err as Error)?.message ?? err), 256);
          }
          recorder.record(EventType.PgQueryEnd, payload, { spanId, requestId });
        } catch {
          // Never throw into user code.
        }
      };

      try {
        const last = args[args.length - 1];
        if (typeof last === 'function') {
          args[args.length - 1] = function (this: unknown, err: unknown): unknown {
            done(err);
            // eslint-disable-next-line prefer-rest-params
            return last.apply(this, arguments);
          };
          return origQuery.apply(this, args);
        }
      } catch {
        // Fall through to the promise path.
      }

      const out = origQuery.apply(this, args);
      try {
        if (out && typeof out.then === 'function') {
          // Return the DERIVED promise: attaching handlers to `out` directly
          // would mark its rejection "handled" and mute unhandledRejection
          // for fire-and-forget queries (audit M3b). The derived chain
          // records the end and re-throws, so the caller's promise keeps
          // native rejection semantics.
          return out.then(
            (v: unknown) => {
              done();
              return v;
            },
            (e: unknown) => {
              done(e);
              throw e;
            }
          );
        }
        if (out && typeof out.on === 'function') {
          // Submittable path (query(new Query())): pair the span via events
          // so it doesn't render as a phantom in-flight query (audit L3).
          out.once('end', () => done());
          out.once('error', (e: unknown) => {
            done(e);
            if (out.listenerCount('error') === 0) throw e;
          });
        }
      } catch {
        // Ignore — recording the end is best-effort.
      }
      return out;
    };

    (wrappedQuery as any).__flightbox = true;
    pg.Client.prototype.query = wrappedQuery;
  }

  const Pool = pg.Pool;
  if (Pool?.prototype?.connect && !(Pool.prototype.connect as any).__flightbox) {
    const origConnect = Pool.prototype.connect;

    const wrappedConnect = function (this: unknown, cb?: unknown): unknown {
      // ADR 012: shed path — acquire untouched.
      if (isShedding()) return origConnect.call(this, cb);
      const tStart = nowMono();
      const requestId = currentRequestId();
      const record = (): void => {
        try {
          recorder.record(
            EventType.PgPoolWait,
            { waitMs: Number(nowMono() - tStart) / 1e6 },
            { requestId }
          );
        } catch {
          // Never throw into user code.
        }
      };

      if (typeof cb === 'function') {
        return origConnect.call(this, function (this: unknown, ...cbArgs: unknown[]) {
          record();
          return (cb as Function).apply(this, cbArgs);
        });
      }
      const out = origConnect.call(this);
      try {
        if (out && typeof out.then === 'function') out.then(record, record);
      } catch {
        // Best-effort.
      }
      return out;
    };

    (wrappedConnect as any).__flightbox = true;
    Pool.prototype.connect = wrappedConnect;
  }

  return true;
}
