// §11: 40 connections, 95% fast /api/orders, 5% killer /api/search.
// Within a minute the pool saturates and flightbox fires. ONE .fbox appears.
const autocannon = require('autocannon');

const url = process.env.TARGET || 'http://localhost:3000';

const instance = autocannon({
  url,
  connections: 40,
  duration: Number(process.env.DURATION || 90),
  requests: [
    ...Array.from({ length: 19 }, () => ({ method: 'GET', path: '/api/orders' })),
    { method: 'GET', path: '/api/search?q=flux' } // 1-in-20 = 5%
  ]
});

autocannon.track(instance, { renderProgressBar: true });
instance.on('done', (result) => {
  console.log('\np50 %dms  p99 %dms  timeouts %d', result.latency.p50, result.latency.p99, result.timeouts);
  console.log('now: npx fboxrec open .flightbox/staging/pid-*/*.fbox');
});
