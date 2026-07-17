import { nowMono } from '../clock';

export interface TriggerFireInfo {
  type: string;
  reason?: string;
  /**
   * 'sync' = compress on-thread (manual + crash paths, where a returned
   * real path / dying process demand it); default = ADR 016 async pipeline.
   */
  mode?: 'sync' | 'async';
  /**
   * Crash-path firings: the process is dying, so a dump taken minutes ago
   * must not suppress the final-moments dump. Exempt fires skip the normal
   * cooldown; a short crash-to-crash window still dedupes the
   * rejection→rethrow→uncaught cascade into one file.
   */
  exemptFromCooldown?: boolean;
}

/** Crash-to-crash dedupe window (rejection→rethrow→uncaught = one file). */
export const CRASH_DEDUPE_MS = 2000;

/**
 * Central trigger evaluation with cooldown: one storm = one file.
 * Suppressed firings are still recorded as timeline events so the incident
 * shows how bad the storm was.
 */
export class TriggerEngine {
  private lastFireMono: bigint | null = null;
  private lastExemptFireMono: bigint | null = null;

  constructor(
    private readonly cooldownMs: number,
    private readonly onFire: (info: TriggerFireInfo) => string | null,
    private readonly onSuppressed: (info: TriggerFireInfo) => void
  ) {}

  fire(info: TriggerFireInfo): string | null {
    const now = nowMono();
    const windowMs = info.exemptFromCooldown ? CRASH_DEDUPE_MS : this.cooldownMs;
    const last = info.exemptFromCooldown ? this.lastExemptFireMono : this.lastFireMono;
    if (last !== null && Number(now - last) / 1e6 < windowMs) {
      try {
        this.onSuppressed(info);
      } catch {
        // Suppression bookkeeping must never break anything.
      }
      return null;
    }
    // A crash dump also resets the normal cooldown — it *is* the storm's file.
    this.lastFireMono = now;
    if (info.exemptFromCooldown) this.lastExemptFireMono = now;
    return this.onFire(info);
  }
}
