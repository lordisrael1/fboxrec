import { describe, expect, it } from 'vitest';
import { scrubText, needsScrub, luhnValid, allowlistHeaders, capScrub } from '../src/redaction';

describe('redaction (ADR 007)', () => {
  it('fast path: clean strings pass through untouched (same reference)', () => {
    const s = 'GET /api/orders?page=2 completed in 43ms';
    expect(needsScrub(s)).toBe(false);
    expect(scrubText(s)).toBe(s);
  });

  it('masks key=value and key: value secrets', () => {
    expect(scrubText('password=hunter2 rest')).toBe('password=[REDACTED] rest');
    expect(scrubText('{"token": "abc-123", "x": 1}')).toContain('"token": [REDACTED]');
    expect(scrubText('api_key: sk_live_xyz')).toBe('api_key: [REDACTED]');
  });

  it('redacts JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(scrubText(`auth header was ${jwt} ok`)).toContain('[REDACTED:jwt]');
    expect(scrubText(`auth header was ${jwt} ok`)).not.toContain(jwt);
  });

  it('redacts Luhn-valid PANs but not arbitrary long numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(scrubText('card 4111 1111 1111 1111 charged')).toContain('[REDACTED:pan]');
    // 13+ digits, fails Luhn → not a card, keep it (e.g. trace ids).
    expect(scrubText('trace 4111111111111112')).toContain('4111111111111112');
  });

  it('allowlists headers instead of blocklisting', () => {
    const out = allowlistHeaders({
      'Content-Type': 'application/json',
      Authorization: 'Bearer xyz',
      Cookie: 'session=abc',
      'User-Agent': 'test'
    });
    expect(out).toEqual({ 'content-type': 'application/json', 'user-agent': 'test' });
  });

  describe('capScrub — bounded hot-path scan', () => {
    it('caps output at the limit', () => {
      expect(capScrub('x'.repeat(10_000), 512)).toHaveLength(512);
    });

    it('bounds the scan work: a huge clean string is pre-capped before regex', () => {
      // 10 MB clean string; capScrub must not scan all of it. With a 512
      // limit it slices to 4x=2048 first, so this returns near-instantly.
      const huge = 'a'.repeat(10 * 1024 * 1024);
      const start = performance.now();
      const out = capScrub(huge, 512);
      expect(out).toHaveLength(512);
      expect(performance.now() - start).toBeLessThan(50);
    });

    it('still redacts a secret within the retained window', () => {
      expect(capScrub('password=hunter2', 512)).toBe('password=[REDACTED]');
    });
  });
});
