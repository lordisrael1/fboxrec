import * as http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AgentApi } from '../agent';
import { EventType, truncate, LIMITS } from '../encoder';
import { newRequestId, requestStorage, type RequestContext } from '../context';
import { nowMono } from '../clock';
import { isShedding } from '../load-shedding';
import { scrubText, capScrub, allowlistHeaders } from '../redaction';
import { trackRequestStart, trackRequestEnd, maybeFireSlow } from '../triggers/slow-request';

/**
 * Patches http.Server.prototype.emit to intercept 'request' — one patch
 * covers Express, Fastify, Koa and bare node:http, on servers created before
 * or after start().
 *
 * Also hosts:
 *  - the token-gated manual dump endpoint (GET /__flightbox/dump with the
 *    x-flightbox-token header — header ONLY: query-string tokens leak into
 *    proxy/access logs). Handled BEFORE the load-shedding check: "grab me a
 *    dump right now" must work precisely when the event loop is melting.
 *  - slow-request firing at request end + in-flight watchdog bookkeeping
 *
 * ADR 004 — strict boundary isolation: the context is created ONLY here, and
 * the requestId is nullified when the response finishes; late events fall
 * back to "orphan" instead of mis-attributing.
 */

let patched = false;
/** Live agent ref — updated on every start() so restart doesn't strand the patch. */
let agentRef: AgentApi;

/** Constant-time equality over hashes — token length stays unobservable too. */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function handleFlightboxEndpoint(
  agent: AgentApi,
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  // Cheap prefix gate first (hot path), then EXACT pathname match — a bare
  // startsWith would swallow app routes like /__flightbox/dump-report.
  if (!agent.config.token || !req.url?.startsWith('/__flightbox/dump')) return false;
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/__flightbox/dump') return false;
    if (req.method !== 'GET') {
      // The path is reserved; the contract is GET-only.
      res.writeHead(405, { allow: 'GET' }).end();
      return true;
    }
    const supplied = String(req.headers['x-flightbox-token'] ?? '');
    if (!supplied || !tokenMatches(supplied, agent.config.token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid token"}');
      return true;
    }
    // The reason lands in artifacts and logs — cap and scrub it like any
    // other untrusted input; a token holder must not get an injection vector.
    const rawReason = url.searchParams.get('reason') ?? 'no reason given';
    const reason = truncate(scrubText(truncate(rawReason, 512)), 120);
    const staged = agent.fire({
      type: 'manual',
      reason: `http endpoint (${reason})`,
      mode: 'sync' // interactive call: the returned path must exist
    });
    res.writeHead(staged ? 200 : 429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ staged: staged ?? null, suppressed: staged === null }));
  } catch {
    try {
      res.writeHead(500);
      res.end();
    } catch {
      /* socket already gone */
    }
  }
  return true;
}

export function instrumentHttpServer(agent: AgentApi): void {
  agentRef = agent;
  if (patched) return;
  patched = true;

  const orig = http.Server.prototype.emit;

  const flightboxEmit = function (this: http.Server, event: string | symbol): boolean {
    // eslint-disable-next-line prefer-rest-params
    const args = arguments;
    if (event !== 'request') {
      return (orig as Function).apply(this, args) as boolean;
    }

    const agent = agentRef;

    // The manual dump endpoint outranks load-shedding: it exists FOR the
    // moments when the loop is lagging (audit M7).
    try {
      if (handleFlightboxEndpoint(agent, args[1] as http.IncomingMessage, args[2] as http.ServerResponse)) {
        return true;
      }
    } catch {
      // Endpoint handling must never break request dispatch.
    }

    // ADR 012: under load-shedding, zero context creation, zero recording.
    if (isShedding()) {
      return (orig as Function).apply(this, args) as boolean;
    }

    let ctx: RequestContext;
    try {
      const req = args[1] as http.IncomingMessage;
      const res = args[2] as http.ServerResponse;

      const requestId = newRequestId();
      const tStart = nowMono();
      const method = req.method ?? 'GET';
      // capScrub: bounded scan — a giant attacker URL must not buy
      // unbounded regex time on the hot path.
      const path = capScrub(req.url ?? '', LIMITS.path);
      ctx = { requestId };

      agent.recorder.record(
        EventType.HttpServerStart,
        // Bible §7: headers are allowlisted (content-type, user-agent, ...)
        // — never captured wholesale.
        { method, path, headers: allowlistHeaders(req.headers) },
        { requestId, tMonoNs: tStart }
      );
      trackRequestStart(requestId, method, path);

      const finish = (aborted: boolean): void => {
        try {
          trackRequestEnd(requestId);
          const durMs = Number(nowMono() - tStart) / 1e6;
          agent.recorder.record(
            EventType.HttpServerEnd,
            aborted
              ? { method, path, aborted: true, durMs }
              : { method, path, status: res.statusCode, durMs },
            { requestId }
          );
          maybeFireSlow(agent, method, path, durMs);
        } catch {
          // Never throw into user code.
        }
        // ADR 004: aggressively sever the context at the response boundary.
        ctx.requestId = 0n;
      };
      res.once('finish', () => finish(false));
      res.once('close', () => {
        // 'close' without 'finish' = client aborted / connection died.
        if (!res.writableFinished) finish(true);
      });
    } catch {
      // Instrumentation failure degrades to "unrecorded", never a broken request.
      return (orig as Function).apply(this, args) as boolean;
    }

    return requestStorage.run(ctx, () => (orig as Function).apply(this, args) as boolean);
  };

  http.Server.prototype.emit = flightboxEmit as typeof http.Server.prototype.emit;
}
