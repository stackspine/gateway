/**
 * End-to-end test for the control-plane degradation decision matrix.
 *
 * Exercises every cell of the matrix in docs/degradation.md by driving
 * the same decision + header-construction path the invoke edge function
 * uses on RPC failure. Also runs one live HTTP shape check against the
 * deployed /invoke endpoint when VITE_SUPABASE_URL is set — that
 * confirms header/status wiring survives a real fetch round-trip.
 *
 * Run: deno test --allow-net --allow-env --allow-read \
 *   gateway-oss/gateway/tests/degradation.test.ts
 */

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  __resetPolicyCacheForTests,
  decideDegradedRequest,
  degradedResponseHeaders,
  signSnapshotPayload,
  type PolicySnapshotPayload,
  type PolicySnapshotRow,
} from "../_shared/policy-cache.ts";

const SIGNING_KEY = "e2e-test-signing-key";

function basePayload(): PolicySnapshotPayload {
  return {
    org_id: "org-e2e",
    generated_at: Date.now() / 1000,
    tasks: [
      { id: "t-strict",   key: "billing_charge", sensitivity: "strict",   fail_mode: "closed", degraded_qps_cap: null, is_active: true },
      { id: "t-standard", key: "summarize",      sensitivity: "standard", fail_mode: "closed", degraded_qps_cap: null, is_active: true },
      { id: "t-relaxed",  key: "log_enrich",     sensitivity: "relaxed",  fail_mode: "open",   degraded_qps_cap: 3,    is_active: true },
    ],
    routes: [], route_conditions: [], data_policies: [],
    budget_rules: [], model_profiles: [], providers: [],
  };
}

async function row(opts: { ageSeconds?: number; maxStale?: number } = {}): Promise<PolicySnapshotRow> {
  const p = basePayload();
  const sig = await signSnapshotPayload(p, SIGNING_KEY);
  return {
    version: 42,
    generated_at: new Date(Date.now() - (opts.ageSeconds ?? 0) * 1000).toISOString(),
    max_stale_seconds: opts.maxStale ?? 900,
    signature: sig,
    payload: p,
  };
}

// ---------------------------------------------------------------------------
// Matrix cell coverage — every (state × sensitivity) combination.
// ---------------------------------------------------------------------------

const TASKS = [
  { key: "billing_charge", tier: "strict"   },
  { key: "summarize",      tier: "standard" },
  { key: "log_enrich",     tier: "relaxed"  },
] as const;

Deno.test("matrix: no cache → fail closed for every tier", () => {
  __resetPolicyCacheForTests();
  for (const t of TASKS) {
    const d = decideDegradedRequest(null, t.key);
    assertEquals(d.allow, false, `${t.tier} should fail closed`);
    if (!d.allow) {
      assertEquals(d.reason, "no_cache");
      assertEquals(d.status, 503);
    }
  }
});

Deno.test("matrix: fresh cache → allow every tier with cache_fresh reason", async () => {
  __resetPolicyCacheForTests();
  const snap = await row({ ageSeconds: 15, maxStale: 900 });
  for (const t of TASKS) {
    const d = decideDegradedRequest(snap, t.key);
    assert(d.allow, `${t.tier} should be allowed on fresh cache`);
    if (d.allow) {
      assertEquals(d.reason, "cache_fresh");
      assertEquals(d.version, 42);
    }
  }
});

Deno.test("matrix: stale cache → strict fails closed, standard fails closed, relaxed fails open", async () => {
  __resetPolicyCacheForTests();
  const snap = await row({ ageSeconds: 1200, maxStale: 900 });

  const strict = decideDegradedRequest(snap, "billing_charge");
  assertEquals(strict.allow, false);
  if (!strict.allow) assertEquals(strict.reason, "stale_strict");

  const standard = decideDegradedRequest(snap, "summarize");
  assertEquals(standard.allow, false);
  if (!standard.allow) assertEquals(standard.reason, "stale_standard");

  const relaxed = decideDegradedRequest(snap, "log_enrich");
  assert(relaxed.allow);
  if (relaxed.allow) assertEquals(relaxed.reason, "fail_open");
});

Deno.test("matrix: unknown task_key → fail closed regardless of freshness", async () => {
  __resetPolicyCacheForTests();
  const fresh = await row({ ageSeconds: 10 });
  const stale = await row({ ageSeconds: 5000 });
  for (const snap of [fresh, stale]) {
    const d = decideDegradedRequest(snap, "ghost_task");
    assertEquals(d.allow, false);
    if (!d.allow) assertEquals(d.reason, "no_task");
  }
});

Deno.test("matrix: relaxed fail-open honors per-worker QPS cap", async () => {
  __resetPolicyCacheForTests();
  const snap = await row({ ageSeconds: 1000, maxStale: 900 });
  // cap = 3 in the fixture
  const outcomes = Array.from({ length: 4 }, () => decideDegradedRequest(snap, "log_enrich"));
  assertEquals(outcomes.filter((o) => o.allow).length, 3, "first 3 within cap allowed");
  const last = outcomes[3];
  assertEquals(last.allow, false);
  if (!last.allow) assertEquals(last.reason, "qps_cap_exceeded");
});

// ---------------------------------------------------------------------------
// Header contract — every degraded response carries the observability set.
// ---------------------------------------------------------------------------

Deno.test("headers: degraded responses expose enforcement mode, age, version", async () => {
  const snap = await row({ ageSeconds: 42 });
  const cacheHeaders = degradedResponseHeaders(snap, "cache");
  assertEquals(cacheHeaders["X-Enforcement-Mode"], "degraded");
  assertEquals(cacheHeaders["X-Degradation-Reason"], "cache");
  assertExists(cacheHeaders["X-Policy-Snapshot-Age"]);
  assertEquals(cacheHeaders["X-Policy-Snapshot-Version"], "42");
  assert(Number(cacheHeaders["X-Policy-Snapshot-Age"]) >= 41);

  const foHeaders = degradedResponseHeaders(snap, "fail_open");
  assertEquals(foHeaders["X-Degradation-Reason"], "fail_open");
});

// ---------------------------------------------------------------------------
// Live HTTP smoke — hits the deployed /invoke and validates the fail-closed
// path (no valid API key present, so we expect 401 with X-API-Version).
// Skips silently if the env doesn't point at a real gateway.
// ---------------------------------------------------------------------------

Deno.test("http: /invoke returns structured error headers on unauthenticated call", async () => {
  const url = Deno.env.get("VITE_SUPABASE_URL");
  const anon = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY");
  if (!url || !anon) {
    console.warn("skipping http smoke: VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY not set");
    return;
  }
  const res = await fetch(`${url}/functions/v1/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": anon },
    body: JSON.stringify({ task_key: "any", messages: [{ role: "user", content: "x" }] }),
  });
  await res.text();
  // Missing x-api-key → fail-closed 401 with versioned response.
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("X-API-Version"), "1");
});
