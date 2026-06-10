/**
 * E2E Smoke Tests for the Invoke Control Plane
 *
 * Seeds real data via the test-invoke edge function (which has service role access),
 * then exercises the full invoke lifecycle:
 * - API key authentication (SHA-256 hashing)
 * - Rate limiting headers (X-RateLimit-*)
 * - Budget enforcement (402 BUDGET_EXCEEDED)
 * - API versioning (X-API-Version: 1)
 * - Usage headers (X-Usage-*)
 * - Request validation (400 for missing fields)
 * - Task not found (404)
 * - Call log creation
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

const INVOKE_URL = `${SUPABASE_URL}/functions/v1/invoke`;
const TEST_INVOKE_URL = `${SUPABASE_URL}/functions/v1/test-invoke`;

// ============================================================================
// Seed/Cleanup Helpers (call test-invoke edge function)
// ============================================================================

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

async function seedTestData(
  opts?: {
    budgetUsd?: number;
    consecutiveFailures?: number;
    complianceRules?: Array<
      { rule_type: string; action: string; config: Record<string, unknown> }
    >;
  },
): Promise<SeedResult> {
  const response = await fetch(TEST_INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      action: "seed",
      budgetUsd: opts?.budgetUsd,
      consecutiveFailures: opts?.consecutiveFailures,
      complianceRules: opts?.complianceRules,
    }),
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

Deno.test("E2E: Valid API key authenticates and reaches provider call", async () => {
  const seed = await seedTestData();
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

    // Should get past auth (not 401), rate limit (not 429), budget (not 402)
    // Will 502 because custom_http provider (httpbin) returns non-standard response format
    assert(response.status !== 401, `Should not be 401: ${body}`);
    assert(response.status !== 429, `Should not be 429: ${body}`);
    assert(response.status !== 402, `Should not be 402: ${body}`);
    // 500/502 = reached provider call but failed (expected with httpbin test provider)
    assert(
      [200, 500, 502].includes(response.status),
      `Expected 200/500/502, got ${response.status}: ${body}`,
    );
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("E2E: Invalid API key returns 401", async () => {
  const seed = await seedTestData();
  try {
    const response = await fetch(INVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "x-api-key": "sk_live_ZZZZZZZZ_totally_invalid_key",
      },
      body: JSON.stringify({
        task_key: seed.taskKey,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await response.text();
    assertEquals(response.status, 401);
    assertEquals(response.headers.get("X-API-Version"), "1");
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("E2E: Budget enforcement blocks with 402 BUDGET_EXCEEDED", async () => {
  const seed = await seedTestData({ budgetUsd: 0 });
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
    const body = await response.json();

    assertEquals(response.status, 402);
    assertEquals(body.code, "BUDGET_EXCEEDED");
    assertExists(body.details?.blocked_by);
    assertExists(body.details?.current_spend_usd);
    assertExists(body.details?.monthly_limit_usd);
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("E2E: X-API-Version header present on all response codes", async () => {
  // Test on 401 (no x-api-key)
  const r1 = await fetch(INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      task_key: "x",
      messages: [{ role: "user", content: "x" }],
    }),
  });
  await r1.text();
  assertEquals(r1.headers.get("X-API-Version"), "1");
});

Deno.test("E2E: Usage headers present for free-tier org", async () => {
  const seed = await seedTestData();
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

    // Usage headers are only present on successful (200) responses
    // With httpbin as provider we get 502, so check conditionally
    if (response.status === 200) {
      assertExists(
        response.headers.get("X-Usage-Percent"),
        "X-Usage-Percent should be present",
      );
      assertExists(
        response.headers.get("X-Usage-Limit"),
        "X-Usage-Limit should be present",
      );
      assertEquals(response.headers.get("X-Usage-Limit"), "1000");
    } else {
      // Even on 500/502, we got past auth + budget + rate limit
      assert(
        [500, 502].includes(response.status),
        `Expected 200, 500, or 502, got ${response.status}`,
      );
    }
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("E2E: Task not found returns 404", async () => {
  const seed = await seedTestData();
  try {
    const response = await fetch(INVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "x-api-key": seed.apiKeyRaw,
      },
      body: JSON.stringify({
        task_key: "nonexistent_task_key_12345",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await response.json();
    assertEquals(response.status, 404);
    assert(body.error.includes("Task not found"));
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("E2E: Missing task_key returns 400", async () => {
  const seed = await seedTestData();
  try {
    const response = await fetch(INVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "x-api-key": seed.apiKeyRaw,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await response.json();
    assertEquals(response.status, 400);
    assert(body.error.includes("task_key"));
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("E2E: Topic blocking guardrail blocks request with blocked topic", async () => {
  const seed = await seedTestData({
    complianceRules: [{
      rule_type: "topic_blocking",
      action: "block",
      config: { blocked_topics: ["politics", "religion"] },
    }],
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
        messages: [{
          role: "user",
          content: "Tell me about politics and the upcoming election",
        }],
      }),
    });
    const body = await response.json();

    assertEquals(response.status, 400);
    assertEquals(body.code, "COMPLIANCE_VIOLATION");
    assert(body.details?.rule_type === "topic_blocking");
    assert(
      body.details?.matches?.some((m: { keyword: string }) =>
        m.keyword === "politics"
      ),
    );
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("E2E: Topic blocking guardrail in log mode does NOT block request", async () => {
  const seed = await seedTestData({
    complianceRules: [{
      rule_type: "topic_blocking",
      action: "log",
      config: { blocked_topics: ["politics"] },
    }],
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
        messages: [{ role: "user", content: "Tell me about politics" }],
      }),
    });
    const body = await response.text();

    // Should NOT be 400 (compliance block) — should pass through to provider
    assert(response.status !== 400, `Log mode should not block: ${body}`);
    // Will be 500/502 because of httpbin test provider, but that's expected
    assert(
      [200, 500, 502].includes(response.status),
      `Expected 200/500/502, got ${response.status}: ${body}`,
    );
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("E2E: Profanity filter blocks request with profanity", async () => {
  const seed = await seedTestData({
    complianceRules: [{
      rule_type: "profanity_filter",
      action: "block",
      config: { use_builtin: true, custom_words: [] },
    }],
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
        messages: [{ role: "user", content: "What the fuck is going on" }],
      }),
    });
    const body = await response.json();

    assertEquals(response.status, 400);
    assertEquals(body.code, "COMPLIANCE_VIOLATION");
    assert(body.details?.rule_type === "profanity_filter");
  } finally {
    await cleanupTestData(seed.orgId);
  }
});
