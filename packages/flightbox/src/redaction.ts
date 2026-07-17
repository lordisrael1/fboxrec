/**
 * Redaction engine — ADR 007 fast-path design: a cheap case-insensitive
 * marker scan runs first; heavy regexes execute ONLY on a hit. No hit means
 * zero regex cost on the hot path.
 *
 * Scrubbers (v0.1, non-negotiable set from Bible §7):
 *  - key/value masking for password|token|secret|otp|pin|auth|cookie|...
 *  - JWT pattern
 *  - Luhn-checked PANs (credit card numbers)
 * Plus the HTTP header allowlist.
 */

const SENSITIVE_MARKERS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'auth',
  'apikey',
  'api_key',
  'api-key',
  'session',
  'cookie',
  'otp',
  'pin',
  'credential',
  'private_key',
  'bearer'
];

const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}\b/g;
const KV_RE =
  /\b(password|passwd|secret|token|authorization|auth|api[_-]?key|apikey|session|cookie|otp|pin|credential|bearer)\b(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;)}\]]+)/gi;
const PAN_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** Cheap fast-path gate: does this string even deserve regex time? */
export function needsScrub(s: string): boolean {
  const lower = s.toLowerCase();
  for (const m of SENSITIVE_MARKERS) {
    if (lower.includes(m)) return true;
  }
  if (lower.includes('eyj')) return true;
  return hasLongDigitRun(s);
}

/** Manual scan for 13+ digits (allowing space/dash separators) — no regex. */
function hasLongDigitRun(s: string): boolean {
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      if (++run >= 13) return true;
    } else if (c !== 32 && c !== 45) {
      run = 0;
    }
  }
  return false;
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Scrub free-form text (log lines, error messages, query text). */
export function scrubText(s: string): string {
  if (!needsScrub(s)) return s;
  let out = s;
  if (out.toLowerCase().includes('eyj')) {
    out = out.replace(JWT_RE, '[REDACTED:jwt]');
  }
  out = out.replace(KV_RE, '$1$2[REDACTED]');
  if (hasLongDigitRun(out)) {
    out = out.replace(PAN_CANDIDATE_RE, (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
        ? '[REDACTED:pan]'
        : m;
    });
  }
  return out;
}

/**
 * Scrub-then-truncate, with the scan itself bounded: a caller-supplied
 * megabyte URL must not buy megabytes of regex work before the size limit
 * applies (hot-path guarantee). The 4x pre-cap keeps redaction effective
 * around the final boundary — a secret straddling the cut is truncated
 * away rather than surviving in recognizable form.
 */
export function capScrub(s: string, limit: number): string {
  const preCapped = s.length > limit * 4 ? s.slice(0, limit * 4) : s;
  const scrubbed = scrubText(preCapped);
  return scrubbed.length > limit ? scrubbed.slice(0, limit) : scrubbed;
}

/** Bible §7: headers are ALLOWLISTED, never blocklisted. */
export const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'accept',
  'x-request-id'
]);

export function allowlistHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  let out: Record<string, string> | undefined;
  for (const key of Object.keys(headers)) {
    if (HEADER_ALLOWLIST.has(key.toLowerCase())) {
      (out ??= {})[key.toLowerCase()] = String(headers[key]);
    }
  }
  return out;
}
