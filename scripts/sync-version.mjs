// Copies packages/flightbox/package.json "version" into the FLIGHTBOX_VERSION
// constant in src/dump/serializer.ts. Runs after `changeset version` (see the
// root "version" script) so the constant can never drift from the published
// version; test/version.test.ts guards the invariant.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(root, 'packages', 'flightbox', 'package.json');
const srcPath = path.join(root, 'packages', 'flightbox', 'src', 'dump', 'serializer.ts');

const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const src = readFileSync(srcPath, 'utf8');
const updated = src.replace(
  /export const FLIGHTBOX_VERSION = '[^']*';/,
  `export const FLIGHTBOX_VERSION = '${version}';`
);
if (updated === src && !src.includes(`FLIGHTBOX_VERSION = '${version}'`)) {
  console.error('sync-version: FLIGHTBOX_VERSION assignment not found in serializer.ts');
  process.exit(1);
}
writeFileSync(srcPath, updated);
console.log(`sync-version: FLIGHTBOX_VERSION -> ${version}`);
