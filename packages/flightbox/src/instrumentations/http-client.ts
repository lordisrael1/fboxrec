import type * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AgentApi } from '../agent';
import { EventType, truncate, LIMITS } from '../encoder';
import { newSpanId, currentRequestId } from '../context';
import { nowMono } from '../clock';
import { isShedding } from '../load-shedding';
import { capScrub } from '../redaction';

/**
 * Outbound HTTP: patches http/https.request+get and global fetch. Events
 * carry host/method/path (scrubbed, truncated) and correlate to the parent
 * request via ALS. ADR 013: these are CJS singleton mutations — valid for
 * core modules; pure-ESM client libs get loader hooks later.
 */

let patched = false;
let agentRef: AgentApi;

function extractTarget(args: unknown[]): { method: string; host: string; path: string } {
  let method = 'GET';
  let host = '';
  let path = '';
  const a0 = args[0];
  if (typeof a0 === 'string') {
    try {
      const u = new URL(a0);
      host = u.host;
      path = u.pathname + u.search;
    } catch {
      path = a0;
    }
  } else if (a0 instanceof URL) {
    host = a0.host;
    path = a0.pathname + a0.search;
  } else if (a0 && typeof a0 === 'object') {
    const o = a0 as Record<string, any>;
    host = o.host ?? o.hostname ?? '';
    path = o.path ?? '/';
    method = o.method ?? 'GET';
  }
  const a1 = args[1];
  if (a1 && typeof a1 === 'object' && !(a1 instanceof URL) && typeof a1 !== 'function') {
    const o = a1 as Record<string, any>;
    if (o.method) method = o.method;
    if (o.host || o.hostname) host = o.host ?? o.hostname;
  }
  return { method: String(method).toUpperCase(), host: String(host), path: String(path) };
}

/**
 * ADR 013 in practice: `import * as http` gives a FROZEN ESM namespace —
 * assigning http.request there throws. The CJS module object (via
 * createRequire) is mutable and is what both require() users and the
 * default-import ESM facade read from.
 */
const nodeRequire = createRequire(process.cwd() + '/noop.js');

function wrapModule(mod: { request: any; get: any }): void {
  const origRequest = mod.request.bind(mod);

  const tracedRequest = function (...args: any[]): http.ClientRequest {
    if (isShedding()) return origRequest(...(args as [any]));
    const agent = agentRef;

    let spanId = 0n;
    let requestId = 0n;
    let tStart = 0n;
    let recordedStart = false;
    try {
      const target = extractTarget(args);
      spanId = newSpanId();
      requestId = currentRequestId();
      tStart = nowMono();
      agent.recorder.record(
        EventType.HttpClientStart,
        {
          method: target.method,
          host: truncate(target.host, 256),
          path: capScrub(target.path, LIMITS.path)
        },
        { spanId, requestId, tMonoNs: tStart }
      );
      recordedStart = true;
    } catch {
      // The outbound request must always proceed.
    }

    const req = origRequest(...(args as [any]));

    if (recordedStart) {
      const done = (status?: number, error?: string): void => {
        try {
          const payload: Record<string, unknown> = {
            durMs: Number(nowMono() - tStart) / 1e6
          };
          if (status !== undefined) payload.status = status;
          if (error !== undefined) payload.error = capScrub(error, 256);
          agent.recorder.record(EventType.HttpClientEnd, payload, { spanId, requestId });
        } catch {
          // Best-effort.
        }
      };
      try {
        req.once('response', (res: http.IncomingMessage) => done(res.statusCode));
        // Our listener alone would mark 'error' as handled and silently
        // swallow failures the app never subscribed to. If nobody else is
        // listening once we've recorded, rethrow to restore Node's default
        // crash-loudly semantics (audit M3a).
        req.once('error', (err: Error) => {
          done(undefined, err.message);
          if (req.listenerCount('error') === 0) throw err;
        });
      } catch {
        // Best-effort.
      }
    }
    return req;
  };

  (mod as any).request = tracedRequest;
  (mod as any).get = function (...args: any[]): http.ClientRequest {
    const req = tracedRequest(...args);
    req.end();
    return req;
  };
}

function wrapFetch(): void {
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== 'function') return;

  globalThis.fetch = async function flightboxFetch(
    input: any,
    init?: any
  ): Promise<Response> {
    if (isShedding()) return origFetch(input, init);
    const agent = agentRef;

    let spanId = 0n;
    let requestId = 0n;
    let tStart = 0n;
    let recordedStart = false;
    try {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      let host = '';
      let path = String(url);
      try {
        const u = new URL(url);
        host = u.host;
        path = u.pathname + u.search;
      } catch {
        // Relative or odd URL — keep as-is.
      }
      spanId = newSpanId();
      requestId = currentRequestId();
      tStart = nowMono();
      agent.recorder.record(
        EventType.HttpClientStart,
        {
          method: String(
            init?.method ?? (typeof input === 'object' ? input?.method : undefined) ?? 'GET'
          ).toUpperCase(),
          host: truncate(host, 256),
          path: capScrub(path, LIMITS.path),
          via: 'fetch'
        },
        { spanId, requestId, tMonoNs: tStart }
      );
      recordedStart = true;
    } catch {
      // Proceed regardless.
    }

    const done = (status?: number, error?: string): void => {
      if (!recordedStart) return;
      try {
        const payload: Record<string, unknown> = { durMs: Number(nowMono() - tStart) / 1e6 };
        if (status !== undefined) payload.status = status;
        if (error !== undefined) payload.error = capScrub(error, 256);
        agent.recorder.record(EventType.HttpClientEnd, payload, { spanId, requestId });
      } catch {
        // Best-effort.
      }
    };

    try {
      const res = await origFetch(input, init);
      done(res.status);
      return res;
    } catch (err) {
      done(undefined, (err as Error)?.message ?? String(err));
      throw err;
    }
  };
}

export function instrumentHttpClient(agent: AgentApi): void {
  agentRef = agent;
  if (patched) return;
  patched = true;
  // Each target independently try/caught: one failing must not skip the rest.
  try {
    wrapModule(nodeRequire('node:http'));
  } catch {
    /* degrade: http.request unrecorded */
  }
  try {
    wrapModule(nodeRequire('node:https'));
  } catch {
    /* degrade: https.request unrecorded */
  }
  try {
    wrapFetch();
  } catch {
    /* degrade: fetch unrecorded */
  }
}
