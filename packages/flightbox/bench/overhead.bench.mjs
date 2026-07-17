// Overhead benchmark (Bible §9/§12): identical http servers with and
// without the agent, hammered by autocannon; reports the p50/p99 delta.
// CI gate: exits 1 if the p99 delta exceeds FLIGHTBOX_BENCH_GATE_PCT
// (default 10%). ADR 015's zero-allocation record path earns its keep here.
//
// Noise control: ROUNDS interleaved off/on measurements, gate on the MEDIAN
// delta — a single off/on pair on a shared CI runner is far too noisy to
// gate on. A fresh child per measurement isolates the agent's patches.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';

const DURATION = Number(process.env.BENCH_DURATION || 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 50);
const GATE_PCT = Number(process.env.FLIGHTBOX_BENCH_GATE_PCT || 10);
const ROUNDS = Number(process.env.BENCH_ROUNDS || 5);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Child mode: run one server variant (isolates the agent's patches).
if (process.env.BENCH_CHILD) {
  if (process.env.BENCH_CHILD === 'on') {
    const { start } = await import('../dist/index.mjs');
    start({
      service: 'bench',
      bufferMb: 64,
      dir: process.env.BENCH_DIR,
      triggers: { slowRequestMs: 60_000 },
      log: () => {}
    });
  }
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true,"items":[1,2,3,4,5]}');
  });
  server.listen(0, '127.0.0.1', () => {
    process.send(server.address().port);
  });
} else {
  const measure = async (variant) => {
    const child = fork(fileURLToPath(import.meta.url), [], {
      env: {
        ...process.env,
        BENCH_CHILD: variant,
        BENCH_DIR: `${process.env.TEMP || '/tmp'}/fbox-bench-${Date.now()}-${Math.random()}`
      }
    });
    const [port] = await once(child, 'message');
    // Warmup, then measure.
    await autocannon({ url: `http://127.0.0.1:${port}/`, connections: 10, duration: 2 });
    const r = await autocannon({
      url: `http://127.0.0.1:${port}/`,
      connections: CONNECTIONS,
      duration: DURATION
    });
    child.kill();
    return r;
  };

  const p99 = { off: [], on: [] };
  const p50 = { off: [], on: [] };
  const rps = { off: [], on: [] };
  for (let round = 0; round < ROUNDS; round++) {
    // Interleave off/on within each round so slow patches of a noisy
    // runner hit both variants roughly equally.
    for (const variant of ['off', 'on']) {
      const r = await measure(variant);
      p99[variant].push(r.latency.p99);
      p50[variant].push(r.latency.p50);
      rps[variant].push(r.requests.average);
    }
    process.stdout.write(`  round ${round + 1}/${ROUNDS} done\n`);
  }

  const pct = (a, b) => (b === 0 ? 0 : ((a - b) / b) * 100);
  const mOffP99 = median(p99.off);
  const mOnP99 = median(p99.on);
  const p99Delta = pct(mOnP99, mOffP99);
  const p50Delta = pct(median(p50.on), median(p50.off));
  const rpsDelta = pct(median(rps.on), median(rps.off));

  console.log(`\n== flightbox overhead (median of ${ROUNDS} rounds) ==`);
  console.log(`         ${'off'.padStart(10)} ${'on'.padStart(10)} ${'delta'.padStart(9)}`);
  console.log(`p50 ms   ${median(p50.off).toFixed(1).padStart(10)} ${median(p50.on).toFixed(1).padStart(10)} ${p50Delta.toFixed(1).padStart(8)}%`);
  console.log(`p99 ms   ${mOffP99.toFixed(1).padStart(10)} ${mOnP99.toFixed(1).padStart(10)} ${p99Delta.toFixed(1).padStart(8)}%`);
  console.log(`req/s    ${median(rps.off).toFixed(0).padStart(10)} ${median(rps.on).toFixed(0).padStart(10)} ${rpsDelta.toFixed(1).padStart(8)}%`);

  if (p99Delta > GATE_PCT) {
    console.error(`\nGATE FAILED: median p99 overhead ${p99Delta.toFixed(1)}% > ${GATE_PCT}%`);
    process.exit(1);
  }
  console.log(`\ngate passed: median p99 overhead ${p99Delta.toFixed(1)}% <= ${GATE_PCT}%`);
  process.exit(0);
}
