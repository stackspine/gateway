import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const hasServiceKey = SUPABASE_URL !== "" && SUPABASE_SERVICE_KEY !== "";
const supabase = hasServiceKey
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

/**
 * Test helpers — seed and cleanup a minimal org with caching settings
 */
const TEST_PREFIX = "cache_test_";
let orgId: string;
let _taskId: string;
let apiKey: string;

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function seedTestData(cacheEnabled: boolean, ttlMinutes = 60) {
  if (!supabase) throw new Error("No service key");
  // Create org with specific cache settings
  const { data: org } = await supabase!.from("organizations").insert({
    name: `${TEST_PREFIX}org`,
    slug: `${TEST_PREFIX}${Date.now()}`,
    prompt_cache_enabled: cacheEnabled,
    prompt_cache_ttl_minutes: ttlMinutes,
  }).select("id").single();
  orgId = org!.id;

  // Create task
  const { data: task } = await supabase!.from("tasks").insert({
    org_id: orgId,
    key: `${TEST_PREFIX}task`,
    name: "Cache Test Task",
    system_prompt: "You are a test assistant.",
  }).select("id").single();
  taskId = task!.id;

  // Create API key
  apiKey = `sk_test_${crypto.randomUUID().replace(/-/g, "")}`;
  const keyHash = await hashKey(apiKey);
  await supabase!.from("api_keys").insert({
    org_id: orgId,
    name: "cache-test-key",
    key_hash: keyHash,
    key_prefix: apiKey.substring(0, 8),
  });

  // We intentionally do NOT create routes — cache tests focus on
  // the cache lookup/write logic, not provider calls.
  // For cache HIT tests, we pre-seed the prompt_cache table.
}

async function cleanup() {
  if (!orgId || !supabase) return;
  await supabase!.from("prompt_cache").delete().eq("org_id", orgId);
  await supabase!.from("call_logs").delete().eq("org_id", orgId);
  await supabase!.from("api_keys").delete().eq("org_id", orgId);
  await supabase!.from("tasks").delete().eq("org_id", orgId);
  await supabase!.from("organizations").delete().eq("id", orgId);
}

// ============================================================================
// Tests
// ============================================================================

Deno.test({
  name: "Prompt Cache - cache HIT returns cached response with zero cost",
  ignore: !hasServiceKey,
  fn: async () => {
    try {
      await seedTestData(true, 60);

      // Pre-seed a cache entry
      const messages = [{ role: "user", content: "Hello cache test" }];
      const cachePayload = JSON.stringify({
        task_key: `${TEST_PREFIX}task`,
        messages,
      });
      const hashBuf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(cachePayload),
      );
      const cacheKeyHash = Array.from(new Uint8Array(hashBuf)).map((b) =>
        b.toString(16).padStart(2, "0")
      ).join("");

      await supabase!.from("prompt_cache").upsert({
        org_id: orgId,
        cache_key_hash: cacheKeyHash,
        response_content: "Cached hello response",
        usage_metadata: {
          model: "test-model",
          provider: "openai",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        cost_usd: 0.001,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }, { onConflict: "org_id,cache_key_hash" });

      // Call invoke
      const res = await fetch(`${SUPABASE_URL}/functions/v1/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          task_key: `${TEST_PREFIX}task`,
          messages,
        }),
      });

      const body = await res.json();

      assertEquals(res.status, 200);
      assertEquals(body.content, "Cached hello response");
      assertEquals(body.cost_usd, 0);
      assertEquals(body.cache, "HIT");
      assertEquals(res.headers.get("X-Cache"), "HIT");
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name: "Prompt Cache - cache MISS when caching disabled",
  ignore: !hasServiceKey,
  fn: async () => {
    try {
      await seedTestData(false);

      // Even with a matching cache entry, caching disabled means no lookup
      const messages = [{ role: "user", content: "Hello no cache" }];
      const cachePayload = JSON.stringify({
        task_key: `${TEST_PREFIX}task`,
        messages,
      });
      const hashBuf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(cachePayload),
      );
      const cacheKeyHash = Array.from(new Uint8Array(hashBuf)).map((b) =>
        b.toString(16).padStart(2, "0")
      ).join("");

      await supabase!.from("prompt_cache").upsert({
        org_id: orgId,
        cache_key_hash: cacheKeyHash,
        response_content: "Should not be returned",
        usage_metadata: {},
        cost_usd: 0.001,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }, { onConflict: "org_id,cache_key_hash" });

      const res = await fetch(`${SUPABASE_URL}/functions/v1/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          task_key: `${TEST_PREFIX}task`,
          messages,
        }),
      });

      const body = await res.json();

      // Should NOT return cached content — will fail with "No active route" since
      // we didn't seed routes, proving caching was bypassed
      assertNotEquals(body.content, "Should not be returned");
      assertNotEquals(res.headers.get("X-Cache"), "HIT");
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name: "Prompt Cache - expired cache entry is not returned",
  ignore: !hasServiceKey,
  fn: async () => {
    try {
      await seedTestData(true, 1); // 1 minute TTL

      const messages = [{ role: "user", content: "Hello expired" }];
      const cachePayload = JSON.stringify({
        task_key: `${TEST_PREFIX}task`,
        messages,
      });
      const hashBuf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(cachePayload),
      );
      const cacheKeyHash = Array.from(new Uint8Array(hashBuf)).map((b) =>
        b.toString(16).padStart(2, "0")
      ).join("");

      // Seed an already-expired cache entry
      await supabase!.from("prompt_cache").upsert({
        org_id: orgId,
        cache_key_hash: cacheKeyHash,
        response_content: "Expired response",
        usage_metadata: {},
        cost_usd: 0.001,
        expires_at: new Date(Date.now() - 60 * 1000).toISOString(), // expired 1 min ago
      }, { onConflict: "org_id,cache_key_hash" });

      const res = await fetch(`${SUPABASE_URL}/functions/v1/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          task_key: `${TEST_PREFIX}task`,
          messages,
        }),
      });

      const body = await res.json();

      // Expired entry should not be returned; will fall through to route selection
      assertNotEquals(body.content, "Expired response");
      assertNotEquals(body.cache, "HIT");
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name: "Prompt Cache - streaming requests skip cache even when enabled",
  ignore: !hasServiceKey,
  fn: async () => {
    try {
      await seedTestData(true, 60);

      const messages = [{ role: "user", content: "Hello stream test" }];
      const cachePayload = JSON.stringify({
        task_key: `${TEST_PREFIX}task`,
        messages,
      });
      const hashBuf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(cachePayload),
      );
      const cacheKeyHash = Array.from(new Uint8Array(hashBuf)).map((b) =>
        b.toString(16).padStart(2, "0")
      ).join("");

      // Seed a cache entry that should be ignored for streaming
      await supabase!.from("prompt_cache").upsert({
        org_id: orgId,
        cache_key_hash: cacheKeyHash,
        response_content: "Should not return for stream",
        usage_metadata: {},
        cost_usd: 0.001,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }, { onConflict: "org_id,cache_key_hash" });

      const res = await fetch(`${SUPABASE_URL}/functions/v1/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          task_key: `${TEST_PREFIX}task`,
          messages,
          stream: true,
        }),
      });

      // Consume response body
      const bodyText = await res.text();

      // Streaming bypasses cache — should NOT return the cached content
      // Will fail at route selection since no routes are seeded
      assertNotEquals(res.headers.get("X-Cache"), "HIT");
      assertEquals(bodyText.includes("Should not return for stream"), false);
    } finally {
      await cleanup();
    }
  },
});
