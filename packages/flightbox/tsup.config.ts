import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/register.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node18',
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.mjs' };
    },
    // The shared format package is compiled INTO the dist so users install
    // exactly one package with exactly one runtime dependency (msgpackr).
    noExternal: ['@flightbox/format']
  },
  {
    entry: { 'cli/main': 'src/cli/main.ts' },
    format: ['cjs'],
    target: 'node18',
    outExtension() {
      return { js: '.cjs' };
    },
    banner: { js: '#!/usr/bin/env node' },
    noExternal: ['@flightbox/format']
  }
]);
