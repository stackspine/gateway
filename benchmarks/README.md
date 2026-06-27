# StackSpine Benchmarks

This directory contains reproducible benchmarks for the StackSpine gateway.
Every benchmark is a standalone Deno script that writes a JSON artifact the
site can consume.

## Available benchmarks

| Benchmark | Script | Artifact | What it measures |
|---|---|---|---|
| Gateway-local CPU overhead | `latency-overhead.ts` | `latency-overhead.json` | SHA-256, route selection, guardrails, cost projection |
| Budget enforcement | `budget-correctness.ts` | none (pass/fail) | Race-safe budget enforcement under concurrency |
| Sustained throughput | `throughput-sustainability.ts` | `throughput-sustainability.json` | Max RPS before p95 latency exceeds a threshold |
| Failover save rate | `failover-save-rate.ts` | `failover-save-rate.json` | Circuit-breaker detection time and fallback save rate |

## Labeling convention

Numbers on the public benchmark page are either:

- **Measured**: produced by one of the scripts in this directory and read from the JSON artifact.
- **Reference**: illustrative values from public documentation, competitor claims, or conservative estimates, clearly labeled as such until a measurement is run.

To replace a reference value with your own measurement, run the corresponding script and commit the updated JSON artifact.

## Quick start

```bash
# Local CPU overhead (no external services)
cd gateway-oss
deno run --allow-net --allow-read --allow-write benchmarks/latency-overhead.ts

# End-to-end benchmarks (requires a running gateway and service-role key)
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...

deno run --allow-net --allow-env --allow-write benchmarks/throughput-sustainability.ts
deno run --allow-net --allow-env --allow-write benchmarks/failover-save-rate.ts
```

## Committing results

After running a benchmark, commit the updated JSON artifact so the public page
reflects the latest measured numbers.
