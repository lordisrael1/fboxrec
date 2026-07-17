import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base: the SAME build works at viewer.flightbox.dev AND served
  // from the CLI's localhost server out of the npm tarball (Bible §3, §8).
  base: './'
});
