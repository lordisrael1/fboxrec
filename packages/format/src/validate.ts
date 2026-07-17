import { FORMAT_VERSION, type Incident } from './types';

/**
 * Validates a parsed envelope and throws errors a human can act on.
 * Old formatVersions must be supported forever (incident files are forensic
 * records); only files NEWER than this code are rejected.
 */
export function validateIncident(obj: unknown): asserts obj is Incident {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(
      'Not a Flightbox incident: expected a JSON object envelope. ' +
        'Is this actually a .fbox file?'
    );
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.formatVersion !== 'number') {
    throw new Error(
      'Not a Flightbox incident: missing numeric "formatVersion" field.'
    );
  }
  if (o.formatVersion > FORMAT_VERSION) {
    throw new Error(
      `This incident uses formatVersion ${o.formatVersion}, but this viewer ` +
        `only understands up to ${FORMAT_VERSION}. Update the viewer ` +
        '(or use `npx fboxrec@latest open <file>`).'
    );
  }
  if (o.formatVersion < 1) {
    throw new Error(`Invalid formatVersion ${o.formatVersion}.`);
  }
  if (o.meta === null || typeof o.meta !== 'object') {
    throw new Error('Corrupt incident: missing "meta" object.');
  }
  // Deep meta checks (audit H2): the viewer dereferences these directly —
  // a truncated or hand-edited file must fail HERE with a human message,
  // never as a blank page deep inside a render.
  const meta = o.meta as Record<string, unknown>;
  if (typeof meta.service !== 'string') {
    throw new Error('Corrupt incident: meta.service is missing or not a string.');
  }
  if (typeof meta.capturedAt !== 'string') {
    throw new Error('Corrupt incident: meta.capturedAt is missing or not a string.');
  }
  if (meta.trigger === null || typeof meta.trigger !== 'object' ||
      typeof (meta.trigger as Record<string, unknown>).type !== 'string') {
    throw new Error('Corrupt incident: meta.trigger.type is missing.');
  }
  if (typeof meta.eventCount !== 'number' || !Number.isFinite(meta.eventCount)) {
    throw new Error('Corrupt incident: meta.eventCount is missing or not a number.');
  }
  if (typeof meta.windowMs !== 'number' || !Number.isFinite(meta.windowMs)) {
    throw new Error('Corrupt incident: meta.windowMs is missing or not a number.');
  }
  if (!Array.isArray(o.events)) {
    throw new Error('Corrupt incident: "events" is not an array.');
  }
  for (let i = 0; i < (o.events as unknown[]).length; i++) {
    const e = (o.events as unknown[])[i] as Record<string, unknown> | null;
    if (
      e === null ||
      typeof e !== 'object' ||
      typeof e.wallMs !== 'number' ||
      !Number.isFinite(e.wallMs) ||
      typeof e.type !== 'string' ||
      e.data === null ||
      typeof e.data !== 'object'
    ) {
      throw new Error(
        `Corrupt incident: event #${i} is malformed ` +
          '(expected numeric wallMs, string type, object data).'
      );
    }
  }
}
