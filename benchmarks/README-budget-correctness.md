# Budget Correctness Benchmark

Most AI gateways advertise budget controls. Few prove they survive concurrency.

This script validates that StackSpine's `Pre-Request Budget Enforcement` (Patent
Pending) is race-safe: given a fixed budget cap and N parallel requests, the
gateway must never permit more spend than the cap allows — even with 50+
simultaneous in-flight requests racing for the last few cents.

## Why this matters

Without race-safe enforcement, a gateway can over-spend by 10–30% under
concurrent load because each request reads the spend counter, then independently
decides to allow itself through before the others have updated the counter. The
result: budget violated, customer surprised.

StackSpine's pre-flight RPC (`resolve_invoke_context`) reads spend and applies
the limit inside a single Postgres transaction. Combined with the per-row
`call_logs` insert that records cost, the system serializes correctly.

## How it works

1. Set up a task with a $1.00 monthly budget and a hard-enforce rule.
2. Fire 50 concurrent calls, each costing ~$0.10.
3. Expect: at most 10 succeed (spending ≤ $1.00), the remaining 40 return
   HTTP 402 `BUDGET_EXCEEDED`.
4. Pass criterion: `actual_spend ≤ budget` and `|drift| ≤ 1%`.

## Run it

```bash
GATEWAY_URL=https://api.stackspine.com \
API_KEY=ssk_live_... \
TASK_KEY=bench-budget \
BUDGET_USD=1.00 \
COST_PER_REQ=0.10 \
CONCURRENCY=50 \
  deno run --allow-net --allow-env budget-correctness.ts
```

## Reference results

| Concurrency | Budget | Cost/req | Allowed | Blocked | Actual spend | Drift |
|---:|---:|---:|---:|---:|---:|---:|
| 10  | $1.00 | $0.10 | 10  | 0   | $1.0000 | 0.00% |
| 50  | $1.00 | $0.10 | 10  | 40  | $1.0000 | 0.00% |
| 100 | $1.00 | $0.10 | 10  | 90  | $1.0000 | 0.00% |
| 500 | $5.00 | $0.10 | 50  | 450 | $5.0000 | 0.00% |

(Run on AWS m6i.2xlarge against a single StackSpine self-host node, Postgres 15.)

## What this proves

- Pre-flight budget checks are atomic at the Postgres transaction boundary.
- High concurrency does not leak past the budget ceiling.
- HTTP 402 responses are returned within standard p95 latency bounds.

If you reproduce different numbers on your own infrastructure, please open an
issue at https://github.com/stackspine/gateway-oss/issues with your config.
