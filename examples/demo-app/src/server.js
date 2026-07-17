// The victim. One line of flightbox; the rest is a perfectly ordinary app.
const flightbox = require('fboxrec');
flightbox.start({
  service: 'demo-shop',
  bufferMb: Number(process.env.FLIGHTBOX_BUFFER_MB || 64),
  dir: process.env.FLIGHTBOX_DIR || '.flightbox',
  triggers: { slowRequestMs: Number(process.env.FLIGHTBOX_TRIGGER_SLOW_MS || 5000) }
});

const express = require('express');
const { Pool } = require('pg');
const routes = require('./routes');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://demo:demo@localhost:5433/demo',
  max: 10 // §11: ten slots is all it takes
});

const app = express();
app.use(routes(pool));
app.get('/healthz', (req, res) => res.send('ok'));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`demo-shop listening on :${port} — 2M rows, pool max 10, bug armed`);
});
