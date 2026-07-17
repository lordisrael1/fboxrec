import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request context. Every event recorded inside a request's async continuation
 * (queries, outbound calls, logs) inherits the requestId — this is what makes
 * swimlane nesting in the viewer possible.
 */

export interface RequestContext {
  requestId: bigint;
}

export const requestStorage = new AsyncLocalStorage<RequestContext>();

let nextRequestId = 1n;
let nextSpanId = 1n;

// The wire header is u64; letting the counter grow past 2^64 would make
// writeBigUInt64LE throw and events silently vanish (recorder swallows).
// Wrap explicitly and skip 0 (0 = "outside any request" sentinel).
const U64_MASK = 0xffffffffffffffffn;

export function newRequestId(): bigint {
  const id = nextRequestId;
  nextRequestId = (nextRequestId + 1n) & U64_MASK;
  if (nextRequestId === 0n) nextRequestId = 1n;
  return id;
}

export function newSpanId(): bigint {
  const id = nextSpanId;
  nextSpanId = (nextSpanId + 1n) & U64_MASK;
  if (nextSpanId === 0n) nextSpanId = 1n;
  return id;
}

/** 0n means "outside any request". */
export function currentRequestId(): bigint {
  return requestStorage.getStore()?.requestId ?? 0n;
}

export function runWithRequest<T>(requestId: bigint, fn: () => T): T {
  return requestStorage.run({ requestId }, fn);
}
