/**
 * Budget Correctness Benchmark
 *
 * Validates that StackSpine's pre-call budget enforcement is race-safe under
 * high concurrency: given a $1.00 budget, firing N concurrent requests at
 * ~$0.10 each must NEVER allow more than 10 to succeed.
 *
 * Run:
 *   GATEWAY_URL=https://api.example.com \
 *   API_KEY=ssk_live_... \
 *   TASK_KEY=bench-budget \
 *   BUDGET_USD=1.00 \
 *   COST_PER_REQ=0.10 \
 *   CONCURRENCY=50 \
 *     deno run --allow-net --allow-env budget-correctness.ts
 *
 * Pass criteria: actual_spend ≤ budget AND drift_pct ≤ 1%
 */

const GATEWAY_URL = Deno.env.get('GATEWAY_URL') || 'http://localhost:8787';
const API_KEY = Deno.env.get('API_KEY') || '';
const TASK_KEY = Deno.env.get('TASK_KEY') || 'bench-budget';
const BUDGET_USD = Number(Deno.env.get('BUDGET_USD') || '1.00');
const COST_PER_REQ = Number(Deno.env.get('COST_PER_REQ') || '0.10');
const CONCURRENCY = Number(Deno.env.get('CONCURRENCY') || '50');

if (!API_KEY) {
  console.error('Set API_KEY env var');
  Deno.exit(1);
}

interface CallResult { status: number; cost: number; blocked: boolean; latency_ms: number }

async function fireOne(): Promise<CallResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${TASK_KEY}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        task_key: TASK_KEY,
        messages: [{ role: 'user', content: 'budget-correctness-probe' }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    return {
      status: res.status,
      cost: Number(body?.usage?.cost_usd ?? (res.status === 200 ? COST_PER_REQ : 0)),
      blocked: res.status === 402,
      latency_ms: performance.now() - start,
    };
  } catch (_e) {
    return { status: 0, cost: 0, blocked: false, latency_ms: performance.now() - start };
  }
}

async function run() {
  console.log(`\n📊 Budget correctness benchmark`);
  console.log(`   Gateway: ${GATEWAY_URL}`);
  console.log(`   Budget:      $${BUDGET_USD.toFixed(2)}`);
  console.log(`   Cost/req:    $${COST_PER_REQ.toFixed(2)}`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  console.log(`   Expected max successful calls: ${Math.floor(BUDGET_USD / COST_PER_REQ)}`);
  console.log('');

  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => fireOne()));
  const elapsed = performance.now() - t0;

  const allowed = results.filter((r) => r.status === 200);
  const blocked = results.filter((r) => r.blocked);
  const errors = results.filter((r) => r.status !== 200 && !r.blocked);
  const actualSpend = allowed.reduce((s, r) => s + r.cost, 0);
  const drift = actualSpend - BUDGET_USD;
  const driftPct = BUDGET_USD > 0 ? (drift / BUDGET_USD) * 100 : 0;
  const avgLatency = results.reduce((s, r) => s + r.latency_ms, 0) / results.length;

  console.log('Results');
  console.log('───────');
  console.log(`  Allowed:        ${allowed.length.toString().padStart(4)} requests`);
  console.log(`  Blocked (402):  ${blocked.length.toString().padStart(4)} requests`);
  console.log(`  Errors:         ${errors.length.toString().padStart(4)} requests`);
  console.log(`  Actual spend:   $${actualSpend.toFixed(4)}`);
  console.log(`  Budget cap:     $${BUDGET_USD.toFixed(4)}`);
  console.log(`  Drift:          $${drift.toFixed(4)} (${driftPct.toFixed(3)}%)`);
  console.log(`  Wall time:      ${elapsed.toFixed(0)}ms`);
  console.log(`  Avg latency:    ${avgLatency.toFixed(1)}ms`);
  console.log('');

  const pass = actualSpend <= BUDGET_USD && Math.abs(driftPct) <= 1.0;
  console.log(pass ? '✅ PASS — budget enforcement is race-safe' : '❌ FAIL — over-spend or drift exceeds tolerance');
  Deno.exit(pass ? 0 : 1);
}

run();
