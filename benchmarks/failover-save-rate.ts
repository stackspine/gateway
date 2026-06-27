/**
 * Failover Save-Rate Benchmark
 *
 * Simulates a primary provider outage and measures how quickly StackSpine's
 * circuit breaker opens and how many requests are saved by the fallback route.
 *
 * Run:
 *   SUPABASE_URL=https://your-project.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
   TOTAL_REQUESTS=100 \
 *   PRE_FAILURE_WARMUP=5 \
 *     deno run --allow-net --allow-env --allow-write failover-save-rate.ts
 *
 * Output:
 *   gateway-oss/benchmarks/failover-save-rate.json
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const INVOKE_URL = Deno.env.get("INVOKE_URL") || `${SUPABASE_URL}/functions/v1/invoke`;
const TEST_INVOKE_URL = Deno.env.get("TEST_INVOKE_URL") || `${SUPABASE_URL}/functions/v1/test-invoke`;
const TOTAL_REQUESTS = Number(Deno.env.get("TOTAL_REQUESTS") || "100");
const PRE_FAILURE_WARMUP = Number(Deno.env.get("PRE_FAILURE_WARMUP") || "5");
const OUT_FILE = Deno.env.get("OUT_FILE") || "./failover-save-rate.json";

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

interface RequestRecord {
  idx: number;
  status: number;
  latency_ms: number;
  provider_failed: boolean;
  succeeded: boolean;
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

async function addFallbackRoute(
  supabase: ReturnType<typeof createClient>,
  seed: SeedResult,
): Promise<{ providerId: string; modelProfileId: string; routeId: string }> {
  const { data: provider, error: pErr } = await supabase.from("providers").insert({
    org_id: seed.orgId,
    name: "Failover Fallback Provider",
    type: "custom_http",
    api_key_encrypted: "fake-key-for-testing",
    base_url: "https://httpbin.org/post",
    is_active: true,
    consecutive_failures: 0,
  }).select("id").single();
  if (pErr || !provider) throw new Error(`Failed to insert fallback provider: ${pErr?.message}`);

  const { data: model, error: mErr } = await supabase.from("model_profiles").insert({
    org_id: seed.orgId,
    provider_id: provider.id as string,
    label: "failover-fallback-model",
    provider_model_name: "failover-model",
    cost_per_input_token: 0.00001,
    cost_per_output_token: 0.00003,
    is_active: true,
  }).select("id").single();
  if (mErr || !model) throw new Error(`Failed to insert fallback model: ${mErr?.message}`);

  const { data: route, error: rErr } = await supabase.from("routes").insert({
    org_id: seed.orgId,
    task_id: seed.taskId,
    model_profile_id: model.id as string,
    strategy: "fallback",
    is_active: true,
    weight: 100,
  }).select("id").single();
  if (rErr || !route) throw new Error(`Failed to insert fallback route: ${rErr?.message}`);

  return { providerId: provider.id as string, modelProfileId: model.id as string, routeId: route.id as string };
}

async function makeFailingProvider(supabase: ReturnType<typeof createClient>, providerId: string) {
  const { error } = await supabase.from("providers").update({
    base_url: "https://httpbin.org/status/500",
  }).eq("id", providerId);
  if (error) throw new Error(`Failed to update primary provider: ${error.message}`);
}

async function resetProviderCircuit(supabase: ReturnType<typeof createClient>, providerId: string) {
  await supabase.from("providers").update({
    consecutive_failures: 0,
    circuit_opened_at: null,
  }).eq("id", providerId);
}

async function fireRequest(seed: SeedResult, idx: number): Promise<RequestRecord> {
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
        messages: [{ role: "user", content: "failover probe" }],
      }),
    });
    const latency = performance.now() - t0;
    // With a failing primary and working fallback, the gateway returns 200 once
    // the circuit opens, and 502 while it is still trying the primary.
    return {
      idx,
      status: res.status,
      latency_ms: latency,
      provider_failed: res.status === 502,
      succeeded: res.status === 200,
    };
  } catch (_e) {
    return {
      idx,
      status: 0,
      latency_ms: performance.now() - t0,
      provider_failed: true,
      succeeded: false,
    };
  }
}

async function run() {
  console.log("\n📊 StackSpine failover save-rate benchmark");
  console.log(`   Gateway: ${INVOKE_URL}`);
  console.log(`   Total requests: ${TOTAL_REQUESTS}`);
  console.log(`   Pre-failure warmup: ${PRE_FAILURE_WARMUP}`);
  console.log("");

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const seed = await seedTestData();
  console.log(`   Seeded test org: ${seed.orgId}`);

  let fallback: { providerId: string; modelProfileId: string; routeId: string } | null = null;
  const records: RequestRecord[] = [];

  try {
    fallback = await addFallbackRoute(supabase, seed);
    console.log(`   Added fallback route: ${fallback.routeId}`);

    // Warmup with a working primary to establish the baseline.
    for (let i = 0; i < PRE_FAILURE_WARMUP; i++) {
      records.push(await fireRequest(seed, i));
    }

    // Force the primary provider to fail. The circuit breaker needs 3 consecutive
    // failures to open, so requests will fail until the gateway marks it open.
    await makeFailingProvider(supabase, seed.providerId);
    console.log("   Primary provider switched to failing endpoint");

    const failureStart = performance.now();
    for (let i = PRE_FAILURE_WARMUP; i < TOTAL_REQUESTS; i++) {
      records.push(await fireRequest(seed, i));
    }
    const failureDuration = performance.now() - failureStart;

    // Post-failure analysis.
    const postFailureRecords = records.slice(PRE_FAILURE_WARMUP);
    const failuresBeforeFirstSuccess = postFailureRecords.findIndex((r) => r.succeeded);
    const firstFailureIdx = records.findIndex((r) => !r.succeeded);
    const firstSuccessAfterFailureIdx = records.findIndex((r, i) => i > firstFailureIdx && r.succeeded);

    let mttdMs = 0;
    if (firstFailureIdx >= 0 && firstSuccessAfterFailureIdx >= 0) {
      mttdMs = records[firstSuccessAfterFailureIdx].latency_ms - records[firstFailureIdx].latency_ms;
    }
    // Bound MTTD to a non-negative, realistic interval and do not let it exceed total duration.
    mttdMs = Math.max(0, Math.min(mttdMs, failureDuration));

    const postFailureFailures = postFailureRecords.filter((r) => !r.succeeded).length;
    const postFailureSuccesses = postFailureRecords.filter((r) => r.succeeded).length;
    const saveRatePct = postFailureRecords.length > 0
      ? (postFailureSuccesses / postFailureRecords.length) * 100
      : 0;

    const result = {
      measured_at: new Date().toISOString(),
      gateway_url: INVOKE_URL,
      scenario: "primary custom_http returns 500; fallback custom_http returns 200",
      total_requests: TOTAL_REQUESTS,
      pre_failure_warmup: PRE_FAILURE_WARMUP,
      failures_before_fallback_ready: failuresBeforeFirstSuccess >= 0 ? failuresBeforeFirstSuccess : postFailureRecords.length,
      mttd_ms: Math.round(mttdMs),
      save_rate_pct: Number(saveRatePct.toFixed(2)),
      post_failure_successes: postFailureSuccesses,
      post_failure_failures: postFailureFailures,
      note:
        "The circuit breaker opens after 3 consecutive failures. Requests after that are routed to the fallback. A small number of residual failures can occur due to races or concurrent updates.",
    };

    await Deno.writeTextFile(OUT_FILE, JSON.stringify(result, null, 2));
    console.log(`\n✅ Wrote results to ${OUT_FILE}`);
    console.log(`   MTTD: ${result.mttd_ms}ms`);
    console.log(`   Save rate: ${result.save_rate_pct}%`);
  } finally {
    if (seed?.orgId) {
      await cleanupTestData(seed.orgId);
      console.log("   Cleaned up test org");
    }
  }
}

run().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
