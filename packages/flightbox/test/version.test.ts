import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLIGHTBOX_VERSION } from '../src/dump/serializer';

describe('version', () => {
  it('FLIGHTBOX_VERSION matches package.json (scripts/sync-version.mjs keeps them in step)', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
    ) as { version: string };
    expect(FLIGHTBOX_VERSION).toBe(pkg.version);
  });
});
