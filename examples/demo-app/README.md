# demo-app — meltdown in 3 commands

A normal-looking Express + Postgres shop with **one planted bug**:
`/api/search` runs a leading-wildcard `ILIKE` over 2M unindexed rows. Each
call holds one of the pool's **10** connections for seconds. Under load, the
pool saturates, every request queues on `pool.connect`, latency explodes —
and CPU stays flat, so classic dashboards tell you nothing.

## Run the meltdown

```bash
docker compose up -d          # postgres:16 on :5433
node src/seed.js              # 2M rows, name column unindexed (be patient)
node src/server.js            # the victim, flightbox armed
```

In another terminal:

```bash
node loadtest.js              # 40 conns, 95% orders / 5% search, 90s
```

Watch the server terminal: the slow-request watchdog fires, and exactly ONE
incident appears (cooldown: one storm = one file):

```
flightbox: 🔴 incident captured (…)
flightbox:    trigger: slowRequest — GET /api/orders still in flight after 5012ms (watchdog)
flightbox:    staged:  .flightbox/staging/pid-1234/incident-….fbox
```

## See the gasp

```bash
npx fboxrec open .flightbox/staging/pid-*/incident-*.fbox
```

What the timeline shows, top to bottom:

1. red `/api/search` bars with giant nested `pg.query` spans (the bug)
2. a wall of `/api/orders` requests stuck in **pool wait** (the symptom)
3. the event-loop lag band, flat (proof it is NOT CPU)
4. the red trigger marker where the watchdog fired

Drag the scrubber to the seconds before the marker: "state at this instant"
shows 40 requests in flight, all waiting on the pool. Case closed.
