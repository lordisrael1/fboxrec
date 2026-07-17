/**
 * Zero-code-change entrypoint, configured purely by FLIGHTBOX_* env vars:
 *
 *   node -r fboxrec/register server.js        (CJS)
 *   node --import fboxrec/register server.js  (ESM)
 */
import { start } from './index';

start();
