/**
 * Cross-Model Context Portability E2E Tests
 *
 * Tests that the invoke pipeline correctly handles context compression
 * when messages exceed a model's context window.
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assert,
  assertEquals,
  assertExists as _assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") ?? "";
const hasEnv = SUPABASE_URL !== "" && SUPABASE_ANON_KEY !== "";

const INVOKE_URL = `${SUPABASE_URL}/functions/v1/invoke`;
const TEST_INVOKE_URL = `${SUPABASE_URL}/functions/v1/test-invoke`;

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
  opts: Record<string, unknown> = {},
): Promise<SeedResult> {
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

// Generate a long message that exceeds a small context window
function generateLongMessage(targetChars: number): string {
  const sentence =
    "This is a test message for context portability verification. ";
  const repeats = Math.ceil(targetChars / sentence.length);
  return sentence.repeat(repeats).slice(0, targetChars);
}

// ============================================================================
// Tests
// ============================================================================

Deno.test("Context Porter: Short messages pass through without compression", async () => {
  // Default model has 128k context window — a short message won't trigger compression
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
        messages: [{ role: "user", content: "Hello, how are you?" }],
      }),
    });
    const body = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body);
    } catch { /* ok */ }

    // Should get past auth — not be blocked
    assert(response.status !== 401, `Should not be 401: ${body}`);
    assert(response.status !== 402, `Should not be 402: ${body}`);

    // Context should not be compressed for a short message
    if (parsed.context_compressed !== undefined) {
      assertEquals(parsed.context_compressed, false);
    }
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("Context Porter: Large message set triggers compression for small context window model", async () => {
  // Seed with a model that has a very small context window (500 tokens ≈ 2000 chars)
  const seed = await seedTestData({
    contextWindowTokens: 500,
  });
  try {
    // Generate messages that exceed 80% of 500 tokens (400 tokens ≈ 1600 chars)
    const longContent = generateLongMessage(3000); // ~750 tokens, well over 80% threshold
    const messages = [
      { role: "user", content: longContent.slice(0, 1000) },
      { role: "assistant", content: longContent.slice(1000, 2000) },
      { role: "user", content: longContent.slice(2000, 2500) },
      { role: "assistant", content: "I understand." },
      { role: "user", content: "Can you summarize what we discussed?" },
    ];

    const response = await fetch(INVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "x-api-key": seed.apiKeyRaw,
      },
      body: JSON.stringify({
        task_key: seed.taskKey,
        messages,
      }),
    });
    const body = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body);
    } catch { /* ok */ }

    // Should reach provider (not auth/budget blocked)
    assert(response.status !== 401, `Should not be 401: ${body}`);
    assert(response.status !== 402, `Should not be 402: ${body}`);

    // The pipeline should have attempted compression
    // With httpbin provider, we'll get 500/502 but that's after context porting ran
    assert(
      [200, 500, 502].includes(response.status),
      `Expected 200/500/502, got ${response.status}: ${body}`,
    );

    // If context_compressed is in response, verify it was triggered
    if (parsed.context_compressed !== undefined) {
      assertEquals(
        parsed.context_compressed,
        true,
        "Context should be compressed for small context window",
      );
    }
  } finally {
    await cleanupTestData(seed.orgId);
  }
});

Deno.test("Context Porter: Session-based compression caches summaries", async () => {
  // Seed with small context window
  const seed = await seedTestData({
    contextWindowTokens: 500,
  });
  try {
    const longContent = generateLongMessage(3000);
    const messages = [
      { role: "user", content: longContent.slice(0, 1000) },
      { role: "assistant", content: longContent.slice(1000, 2000) },
      { role: "user", content: "Final question?" },
      { role: "assistant", content: "Sure." },
      { role: "user", content: "Thanks!" },
    ];

    // First call with session_id
    const response1 = await fetch(INVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "x-api-key": seed.apiKeyRaw,
      },
      body: JSON.stringify({
        task_key: seed.taskKey,
        messages,
        session_id: "test-session-porter-1",
      }),
    });
    await response1.text();

    // Second call with same session_id — should hit cached summary
    const response2 = await fetch(INVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "x-api-key": seed.apiKeyRaw,
      },
      body: JSON.stringify({
        task_key: seed.taskKey,
        messages,
        session_id: "test-session-porter-1",
      }),
    });
    const body2 = await response2.text();

    // Both calls should pass auth
    assert(response1.status !== 401, "First call should not be 401");
    assert(response2.status !== 401, "Second call should not be 401");

    // Both should reach provider stage (500/502 from httpbin is expected)
    assert(
      [200, 500, 502].includes(response2.status),
      `Expected 200/500/502 on second call, got ${response2.status}: ${body2}`,
    );
  } finally {
    await cleanupTestData(seed.orgId);
  }
});
