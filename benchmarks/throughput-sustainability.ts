/**
 * Throughput Sustainability Benchmark
 *
 * Measures the maximum sustained request throughput a single StackSpine gateway
 * node can handle before tail latency exceeds a configurable threshold. The test
 * seeds a temporary tenant via the test-invoke edge function and then ramps load
 * in fixed concurrency steps.
 *
 * Run:
 *   SUPABASE_URL=https://your-project.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   RAMP="1,10,25,50,100,200" \
 *   LATENCY_THRESHOLD_MS=50 \
 *   REQUESTS_PER_LEVEL=200 \
 *     deno run --allow-net --allow-env --allow-write throughput-sustainability.ts
 *
 * Output:
 *   gateway-oss/benchmarks/throughput-sustainability.json
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const INVOKE_URL = Deno.env.get("INVOKE_URL") || `${SUPABASE_URL}/functions/v1/invoke`;
const TEST_INVOKE_URL = Deno.env.get("TEST_INVOKE_URL") || `${SUPABASE_URL}/functions/v1/test-invoke`;
const RAMP = (Deno.env.get("RAMP") || "1,10,25,50,100,200")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);
const REQUESTS_PER_LEVEL = Number(Deno.env.get("REQUESTS_PER_LEVEL") || "200");
const LATENCY_THRESHOLD_MS = Number(Deno.env.get("LATENCY_THRESHOLD_MS") || "50");
const OUT_FILE = Deno.env.get("OUT_FILE") || "./throughput-sustainability.json";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars");
  Deno.exit(1);
}

interface SeedResult {
  orgId: string;
  taskId: string;
  taskKey: string;
  providerId: string;
  modelProfileId: string;
  routeId: string;
  apiKeyId: string;
  apiKeyRaw: string;
}

interface LevelResult {
  concurrency: number;
  requests: number;
  successes: number;
  errors: number;
  rate_limited: number;
  budget_blocked: number;
  rps: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
  avg_ms: number;
  within_threshold: boolean;
}

async function seedTestData(): Promise<SeedResult> {
  const res = await fetch(TEST_INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ action: "seed" }),
  });
  const body = await res.json();
  if (!body.orgId) throw new Error(`Seed failed: ${JSON.stringify(body)}`);
  return body as SeedResult;
}

async function cleanupTestData(orgId: string): Promise<void> {
  await fetch(TEST_INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ action: "cleanup", orgId }),
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function runLevel(seed: SeedResult, concurrency: number): Promise<LevelResult> {
  const requests = REQUESTS_PER_LEVEL;
  const latencies: number[] = [];
  let successes = 0;
  let errors = 0;
  let rateLimited = 0;
  let budgetBlocked = 0;

  const start = performance.now();
  const inFlight = new Set<Promise<void>>();

  for (let i = 0; i < requests; i++) {
    const p = (async () => {
      const t0 = performance.now();
      try {
        const res = await fetch(INVOKE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": seed.apiKeyRaw,
          },
          body: JSON.stringify({
            task_key: seed.taskKey,
            messages: [{ role: "user", content: "throughput probe" }],
          }),
        });
        const latency = performance.now() - t0;
        latencies.push(latency);
        if (res.status === 200) successes++;
        else if (res.status === 429) rateLimited++;
        else if (res.status === 402) budgetBlocked++;
        else errors++;
      } catch (_e) {
        const latency = performance.now() - t0;
        latencies.push(latency);
        errors++;
      }
    })();

    inFlight.add(p);
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
      for (const promise of inFlight) {
        promise.then(() => inFlight.delete(promise)).catch(() => inFlight.delete(promise));
      }
    }
  }

  await Promise.all(inFlight);
  const elapsed = performance.now() - start;

  const sorted = latencies.slice().sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);

  return {
    concurrency,
    requests,
    successes,
    errors,
    rate_limited: rateLimited,
    budget_blocked: budgetBlocked,
    rps: (requests / elapsed) * 1000,
    p50_ms: percentile(sorted, 50),
    p95_ms: p95,
    p99_ms: percentile(sorted, 99),
    min_ms: sorted[0] ?? 0,
    max_ms: sorted[sorted.length - 1] ?? 0,
    avg_ms: latencies.reduce((a, b) => a + b, 0) / latencies.length || 0,
    within_threshold: p95 <= LATENCY_THRESHOLD_MS,
  };
}

async function run() {
  console.log("\n📊 StackSpine throughput sustainability benchmark");
  console.log(`   Gateway: ${INVOKE_URL}`);
  console.log(`   Latency threshold: p95 ≤ ${LATENCY_THRESHOLD_MS}ms`);
  console.log(`   Ramp levels: ${RAMP.join(", ")}`);
  console.log(`   Requests per level: ${REQUESTS_PER_LEVEL}`);
  console.log("");

  const seed = await seedTestData();
  console.log(`   Seeded test org: ${seed.orgId}`);

  const levels: LevelResult[] = [];
  let maxSustainableRps = 0;
  let lastLevel = 0;

  try {
    for (const concurrency of RAMP) {
      const result = await runLevel(seed, concurrency);
      levels.push(result);
      lastLevel = concurrency;

      console.log(
        `   concurrency=${String(concurrency).padStart(4)} | rps=${result.rps.toFixed(0).padStart(6)} | p95=${result.p95_ms.toFixed(1).padStart(6)}ms | success=${result.successes}/${result.requests}`,
      );

      if (result.within_threshold && result.rps > maxSustainableRps) {
        maxSustainableRps = result.rps;
      }

      // Stop ramping if we are already above threshold and there is no value in higher load.
      if (!result.within_threshold && levels.length > 1) break;
    }
  } finally {
    await cleanupTestData(seed.orgId);
    console.log("   Cleaned up test org");
  }

  const result = {
    measured_at: new Date().toISOString(),
    gateway_url: INVOKE_URL,
    latency_threshold_ms: LATENCY_THRESHOLD_MS,
    requests_per_level: REQUESTS_PER_LEVEL,
    ramp_levels: RAMP,
    levels,
    max_sustainable_rps: Math.floor(maxSustainableRps),
    last_ramped_level: lastLevel,
    note:
      "This benchmark measures end-to-end HTTP throughput including the gateway's pre-flight RPC, route selection, and a custom_http provider round-trip. Self-host numbers will vary by hardware, network, and database latency.",
  };

  await Deno.writeTextFile(OUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n✅ Wrote results to ${OUT_FILE}`);
  console.log(`   Max sustainable RPS (p95 ≤ ${LATENCY_THRESHOLD_MS}ms): ${result.max_sustainable_rps}`);
}

run().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
