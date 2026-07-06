/**
 * Unit tests for the edge-local policy-cache module.
 * Run with: deno test supabase/functions/invoke/_shared/policy-cache.test.ts
 */

import { assertEquals, assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  decideDegradedRequest,
  isStale,
  signSnapshotPayload,
  snapshotAgeSeconds,
  verifySnapshotSignature,
  __resetPolicyCacheForTests,
  type PolicySnapshotPayload,
  type PolicySnapshotRow,
} from "./policy-cache.ts";

const SIGNING_KEY = "test-signing-key";

function payload(): PolicySnapshotPayload {
  return {
    org_id: "org-1",
    generated_at: Date.now() / 1000,
    tasks: [
      { id: "t1", key: "sensitive", sensitivity: "strict", fail_mode: "closed", degraded_qps_cap: null, is_active: true },
      { id: "t2", key: "standard",  sensitivity: "standard", fail_mode: "closed", degraded_qps_cap: null, is_active: true },
      { id: "t3", key: "internal",  sensitivity: "relaxed", fail_mode: "open",   degraded_qps_cap: 5,    is_active: true },
    ],
    routes: [], route_conditions: [], data_policies: [],
    budget_rules: [], model_profiles: [], providers: [],
  };
}

async function makeRow(opts: { ageSeconds?: number; maxStale?: number } = {}): Promise<PolicySnapshotRow> {
  const p = payload();
  const sig = await signSnapshotPayload(p, SIGNING_KEY);
  const gen = new Date(Date.now() - (opts.ageSeconds ?? 0) * 1000).toISOString();
  return {
    version: 1,
    generated_at: gen,
    max_stale_seconds: opts.maxStale ?? 900,
    signature: sig,
    payload: p,
  };
}

Deno.test("sign + verify roundtrip", async () => {
  const row = await makeRow();
  assert(await verifySnapshotSignature(row, SIGNING_KEY));
});

Deno.test("verify rejects tampered payload", async () => {
  const row = await makeRow();
  row.payload.tasks[0].sensitivity = "relaxed";
  assertEquals(await verifySnapshotSignature(row, SIGNING_KEY), false);
});

Deno.test("verify rejects wrong key", async () => {
  const row = await makeRow();
  assertEquals(await verifySnapshotSignature(row, "wrong-key"), false);
});

Deno.test("age + staleness math", async () => {
  const fresh = await makeRow({ ageSeconds: 30, maxStale: 900 });
  assert(!isStale(fresh));
  assert(snapshotAgeSeconds(fresh) >= 29 && snapshotAgeSeconds(fresh) <= 31);

  const stale = await makeRow({ ageSeconds: 1000, maxStale: 900 });
  assert(isStale(stale));
});

Deno.test("decision matrix: no cache → fail closed everywhere", () => {
  __resetPolicyCacheForTests();
  const out = decideDegradedRequest(null, "sensitive");
  assertEquals(out.allow, false);
  if (!out.allow) assertEquals(out.reason, "no_cache");
});

Deno.test("decision matrix: fresh cache → allow all", async () => {
  __resetPolicyCacheForTests();
  const row = await makeRow({ ageSeconds: 30 });
  for (const key of ["sensitive", "standard", "internal"]) {
    const out = decideDegradedRequest(row, key);
    assert(out.allow, `expected allow for ${key}`);
    if (out.allow) assertEquals(out.reason, "cache_fresh");
  }
});

Deno.test("decision matrix: stale + strict → fail closed", async () => {
  __resetPolicyCacheForTests();
  const row = await makeRow({ ageSeconds: 1000, maxStale: 900 });
  const out = decideDegradedRequest(row, "sensitive");
  assertEquals(out.allow, false);
  if (!out.allow) assertEquals(out.reason, "stale_strict");
});

Deno.test("decision matrix: stale + standard fail_mode=closed → fail closed", async () => {
  __resetPolicyCacheForTests();
  const row = await makeRow({ ageSeconds: 1000, maxStale: 900 });
  const out = decideDegradedRequest(row, "standard");
  assertEquals(out.allow, false);
  if (!out.allow) assertEquals(out.reason, "stale_standard");
});

Deno.test("decision matrix: stale + relaxed fail_mode=open → allow with cap", async () => {
  __resetPolicyCacheForTests();
  const row = await makeRow({ ageSeconds: 1000, maxStale: 900 });
  // Within cap
  for (let i = 0; i < 5; i++) {
    const out = decideDegradedRequest(row, "internal");
    assert(out.allow, `iter ${i} should be allowed`);
  }
  // Sixth call in the same second exceeds cap=5
  const capped = decideDegradedRequest(row, "internal");
  assertEquals(capped.allow, false);
  if (!capped.allow) assertEquals(capped.reason, "qps_cap_exceeded");
});

Deno.test("decision matrix: unknown task → fail closed", async () => {
  __resetPolicyCacheForTests();
  const row = await makeRow({ ageSeconds: 30 });
  const out = decideDegradedRequest(row, "ghost");
  assertEquals(out.allow, false);
  if (!out.allow) assertEquals(out.reason, "no_task");
});
