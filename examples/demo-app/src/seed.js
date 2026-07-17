// Seeds 2,000,000 products. `name` deliberately has NO index — that absence
// IS the planted bug's fuel (Bible §11).
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://demo:demo@localhost:5433/demo';
const ROWS = Number(process.env.SEED_ROWS || 2_000_000);
const BATCH = 10_000;

const WORDS = [
  'aero', 'bolt', 'carbon', 'delta', 'ember', 'flux', 'gamma', 'helix',
  'ion', 'jet', 'krypton', 'lumen', 'meteor', 'nova', 'orbit', 'pulse',
  'quartz', 'rocket', 'sonic', 'titan', 'ultra', 'vector', 'watt', 'xenon'
];
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log('creating schema...');
  await client.query(`
    DROP TABLE IF EXISTS products;
    CREATE TABLE products (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,          -- no index. on purpose.
      price_cents INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX products_sku_idx ON products (sku);  -- /api/orders stays fast
  `);

  console.log(`seeding ${ROWS.toLocaleString()} rows...`);
  for (let done = 0; done < ROWS; done += BATCH) {
    const values = [];
    for (let i = 0; i < BATCH; i++) {
      const name = `${rand(WORDS)}-${rand(WORDS)}-${rand(WORDS)} ${Math.floor(Math.random() * 9999)}`;
      values.push(`('SKU-${done + i}', '${name}', ${100 + Math.floor(Math.random() * 99900)})`);
    }
    await client.query(
      `INSERT INTO products (sku, name, price_cents) VALUES ${values.join(',')}`
    );
    if ((done / BATCH) % 20 === 0) {
      process.stdout.write(`  ${done.toLocaleString()} / ${ROWS.toLocaleString()}\r`);
    }
  }
  console.log(`\nseeded. table size: ${ROWS.toLocaleString()} rows, name column UNINDEXED.`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
