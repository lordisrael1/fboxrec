// Copies the viewer's Vite build INTO this package (§3): the CLI ships the
// same viewer build as viewer.flightbox.dev, ~55KB gzipped.
//
// The viewer is a workspace devDependency, so `pnpm -r build` topologically
// builds it BEFORE this package — here we only copy. Building it again
// caused a double build and a concurrent race over viewer/dist (audit
// follow-up). The spawn below is a fallback for standalone builds
// (`pnpm --filter fboxrec build` on a fresh checkout) where no viewer
// build has run yet.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = path.resolve(__dirname, '..');
const viewerDir = path.resolve(pkgRoot, '..', 'viewer');
const src = path.join(viewerDir, 'dist');
const dest = path.join(pkgRoot, 'viewer-dist');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  const result = spawnSync('pnpm', ['--dir', viewerDir, 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    console.error('copy-viewer: viewer build failed');
    process.exit(result.status ?? 1);
  }
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`copy-viewer: ${dest} updated`);
