const express = require('express');

module.exports = function routes(pool) {
  const router = express.Router();

  // The fast path: indexed lookup, single-digit milliseconds. 95% of traffic.
  router.get('/api/orders', async (req, res) => {
    const sku = `SKU-${Math.floor(Math.random() * 1_000_000)}`;
    const { rows } = await pool.query(
      'SELECT id, sku, name, price_cents FROM products WHERE sku = $1',
      [sku]
    );
    res.json({ order: rows[0] ?? null });
  });

  // ★ THE PLANTED BUG (Bible §11): leading-wildcard ILIKE over 2M unindexed
  // rows = full table scan. Each call holds a pool connection for seconds.
  // At 10 pool slots and 5% search traffic, the pool saturates, EVERYTHING
  // queues on pool.connect, and the whole app melts — while CPU stays flat.
  router.get('/api/search', async (req, res) => {
    const q = String(req.query.q ?? 'flux');
    const { rows } = await pool.query(
      `SELECT id, sku, name, price_cents FROM products WHERE name ILIKE $1 LIMIT 20`,
      [`%${q}%`]
    );
    res.json({ results: rows });
  });

  return router;
};
