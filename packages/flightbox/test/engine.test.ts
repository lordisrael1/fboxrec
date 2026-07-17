import { describe, expect, it } from 'vitest';
import { TriggerEngine, CRASH_DEDUPE_MS } from '../src/triggers/engine';

describe('trigger engine cooldown (audit M2)', () => {
  function makeEngine(cooldownMs: number) {
    const fired: string[] = [];
    const suppressed: string[] = [];
    const engine = new TriggerEngine(
      cooldownMs,
      (info) => {
        fired.push(info.type);
        return `/staged/${info.type}`;
      },
      (info) => suppressed.push(info.type)
    );
    return { engine, fired, suppressed };
  }

  it('routine triggers respect the cooldown', () => {
    const { engine, fired, suppressed } = makeEngine(60_000);
    expect(engine.fire({ type: 'slowRequest' })).toBeTruthy();
    expect(engine.fire({ type: 'slowRequest' })).toBeNull();
    expect(fired).toEqual(['slowRequest']);
    expect(suppressed).toEqual(['slowRequest']);
  });

  it('a crash dump is NOT suppressed by a recent routine dump', () => {
    const { engine, fired } = makeEngine(60_000);
    engine.fire({ type: 'slowRequest' });
    // Seconds later the process dies — the final-moments dump must happen.
    const staged = engine.fire({ type: 'uncaughtException', exemptFromCooldown: true });
    expect(staged).toBe('/staged/uncaughtException');
    expect(fired).toEqual(['slowRequest', 'uncaughtException']);
  });

  it('crash-to-crash cascade still collapses to one file within the dedupe window', () => {
    const { engine, fired, suppressed } = makeEngine(60_000);
    engine.fire({ type: 'unhandledRejection', exemptFromCooldown: true });
    // rethrow → uncaughtException, microseconds later (< CRASH_DEDUPE_MS).
    expect(CRASH_DEDUPE_MS).toBeLessThanOrEqual(60_000);
    expect(engine.fire({ type: 'uncaughtException', exemptFromCooldown: true })).toBeNull();
    expect(fired).toEqual(['unhandledRejection']);
    expect(suppressed).toEqual(['uncaughtException']);
  });

  it('a crash dump resets the routine cooldown (it IS the storm file)', () => {
    const { engine, fired, suppressed } = makeEngine(60_000);
    engine.fire({ type: 'uncaughtException', exemptFromCooldown: true });
    expect(engine.fire({ type: 'slowRequest' })).toBeNull();
    expect(fired).toEqual(['uncaughtException']);
    expect(suppressed).toEqual(['slowRequest']);
  });
});
