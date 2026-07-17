import { decodeRing, type Recorder } from '../recorder';
import type { DecodedEvent } from '../encoder';

/**
 * ADR 005 — take a dump without blocking or corrupting live traffic:
 * atomically swap a fresh ring in for active writes, then decode the frozen
 * one at leisure. Recording continues uninterrupted throughout.
 */
export function takeFrozenSnapshot(
  recorder: Recorder,
  replacementBytes?: number
): DecodedEvent[] {
  return decodeRing(recorder.freezeAndSwap(replacementBytes));
}
