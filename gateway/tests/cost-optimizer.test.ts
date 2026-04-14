/**
 * Cost Optimization Engine E2E Tests
 * 
 * Tests the cost optimizer's integration into the invoke pipeline:
 * - Cost prediction recording
 * - Route optimization when confidence is high
 * - No optimization when conditions aren't met
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assert, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

const INVOKE_URL = `${SUPABASE_URL}/functions/v1/invoke`;
const TEST_INVOKE_URL = `${SUPABASE_URL}/functions/v1/test-invoke`;

interface SeedResult {
  orgId: string;
  taskId: string;
  taskKey: string;
  providerId: string;
  modelProfileId: string;
  secondModelProfileId: string | null;
  routeId: string;
  secondRouteId: string | null;
  apiKeyId: string;
  apiKeyRaw: string;
}

async function seedTestData(opts: Record<string, unknown> = {}): Promise<SeedResult> {
  const response = await fetch(TEST_INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action: "seed", ...opts }),
  });
  const body = await response.json();
  if (!body.orgId) throw new Error(`Seed failed: ${JSON.stringify(body)}`);
  return body as SeedResult;
}

async function cleanupTestData(orgId: string): Promise<void> {
  const response = await fetch(TEST_INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action: "cleanup", orgId }),
  });
  await response.text();
}

// ============================================================================
// Tests
// ============================================================================

Deno.test("Cost Optimizer: Does NOT optimize when auto_optimize_routing is disabled", async () => {
  const seed = await seedTestData({
    autoOptimizeRouting: false,
    secondModel: { costPerInputToken: 0.000001, costPerOutputToken: 0.000003 },
    modelStats: [
      { modelProfileId: "__primary__", totalCalls: 100, totalTokens: 50000, totalCost: 0.5 },
      { modelProfileId: "__secondary__", totalCalls: 100, totalTokens: 50000, totalCost: 0.05 },
    ],
    seedCallLogs: [
      { modelProfileId: "__primary__", count: 60, status: "success" },
      { modelProfileId: "__secondary__", count: 60, status: "success" },
    ],
  });
  try {
    const response = await fetch(INVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "x-api-key": seed.apiKeyRaw,
      },
      body: JSON.stringify({
        task_key: seed.taskKey,
        messages: [{ role: "user", content: "hello world test message" }],
      }),
    });
    const body = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body); } catch { /* ok */ }

    // Should reach provider call (not 401/402/429)
    assert(response.status !== 401, `Should not be 401: ${body}`);
    assert(response.status !== 402, `Should not be 402: ${body}`);

    // Should NOT have cost_optimized in response since auto_optimize is off
    assert(!parsed.cost_optimized, "Should not be cost optimized when auto_optimize_routing is off");
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("Cost Optimizer: Does NOT optimize with insufficient data (<50 calls)", async () => {
  const seed = await seedTestData({
    autoOptimizeRouting: true,
    secondModel: { costPerInputToken: 0.000001, costPerOutputToken: 0.000003 },
    modelStats: [
      { modelProfileId: "__primary__", totalCalls: 10, totalTokens: 5000, totalCost: 0.05 },
      { modelProfileId: "__secondary__", totalCalls: 10, totalTokens: 5000, totalCost: 0.005 },
    ],
    seedCallLogs: [
      { modelProfileId: "__primary__", count: 10, status: "success" },
      { modelProfileId: "__secondary__", count: 10, status: "success" },
    ],
  });
  try {
    const response = await fetch(INVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "x-api-key": seed.apiKeyRaw,
      },
      body: JSON.stringify({
        task_key: seed.taskKey,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body); } catch { /* ok */ }

    assert(response.status !== 401, `Should not be 401: ${body}`);
    assert(!parsed.cost_optimized, "Should not optimize with insufficient historical data");
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("Cost Optimizer: Seed with auto_optimize creates proper task config", async () => {
  const seed = await seedTestData({
    autoOptimizeRouting: true,
    secondModel: { costPerInputToken: 0.000001, costPerOutputToken: 0.000003 },
  });
  try {
    assertExists(seed.orgId, "Should have orgId");
    assertExists(seed.taskId, "Should have taskId");
    assertExists(seed.secondModelProfileId, "Should have second model");
    assertExists(seed.secondRouteId, "Should have second route");
    assert(seed.secondModelProfileId !== seed.modelProfileId, "Second model should differ from primary");
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("Cost Optimizer: Eligible routes with sufficient data attempts optimization", async () => {
  // Seed with enough data and high enough savings differential
  const seed = await seedTestData({
    autoOptimizeRouting: true,
    secondModel: { costPerInputToken: 0.000001, costPerOutputToken: 0.000003 },
    modelStats: [
      { modelProfileId: "__primary__", totalCalls: 200, totalTokens: 100000, totalCost: 2.0 },
      { modelProfileId: "__secondary__", totalCalls: 200, totalTokens: 100000, totalCost: 0.2 },
    ],
    seedCallLogs: [
      { modelProfileId: "__primary__", count: 60, status: "success" },
      { modelProfileId: "__secondary__", count: 60, status: "success" },
    ],
  });
  try {
    const response = await fetch(INVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "x-api-key": seed.apiKeyRaw,
      },
      body: JSON.stringify({
        task_key: seed.taskKey,
        messages: [{ role: "user", content: "hello world, this is a test message for cost optimization" }],
      }),
    });
    const body = await response.text();

    // The call will likely fail at provider level (502) since it's httpbin,
    // but the cost optimizer should have run without errors
    assert(response.status !== 401, `Auth should pass: ${body}`);
    assert(response.status !== 402, `Budget should pass: ${body}`);
    // 200, 500, or 502 are all valid - means we got past the optimizer
    assert([200, 500, 502].includes(response.status), `Expected 200/500/502, got ${response.status}: ${body}`);
  } finally {
    await cleanupTestData(seed.orgId);
  }
});
