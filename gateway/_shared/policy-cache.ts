/**
 * @fileoverview Edge-local policy snapshot cache for graceful degradation.
 *
 * When `resolve_invoke_context` (the primary control-plane RPC) fails,
 * the invoke function falls back to the most recent signed policy snapshot
 * for the caller's organization. The snapshot never contains live spend,
 * idempotency, or provider secrets — only routing / policy definitions.
 *
 * Decision matrix documented in docs/degradation.md.
 *
 * @module invoke/_shared/policy-cache
 */

// deno-lint-ignore-file no-explicit-any

export interface TaskSnapshot {
  id: string;
  key: string;
  sensitivity: "strict" | "standard" | "relaxed";
  fail_mode: "closed" | "open" | "cache_only";
  degraded_qps_cap: number | null;
  is_active: boolean;
}

export interface PolicySnapshotPayload {
  org_id: string;
  generated_at: number;
  tasks: TaskSnapshot[];
  routes: any[];
  route_conditions: any[];
  data_policies: any[];
  budget_rules: any[];
  model_profiles: any[];
  providers: any[];
}

export interface PolicySnapshotRow {
  version: number;
  generated_at: string;
  max_stale_seconds: number;
  signature: string;
  payload: PolicySnapshotPayload;
}

interface CachedSnapshot {
  row: PolicySnapshotRow;
  fetchedAt: number;
}

const SOFT_TTL_MS = 60_000;
const cache = new Map<string, CachedSnapshot>();

// In-process degraded-mode QPS buckets — best-effort per edge worker.
const degradedBuckets = new Map<string, { count: number; windowStart: number }>();

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifySnapshotSignature(
  row: PolicySnapshotRow,
  signingKey: string,
): Promise<boolean> {
  if (!signingKey || !row.signature) return false;
  const canonical = JSON.stringify(row.payload);
  const expected = await hmacHex(signingKey, canonical);
  // constant-time-ish compare
  if (expected.length !== row.signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ row.signature.charCodeAt(i);
  }
  return diff === 0;
}

export async function signSnapshotPayload(
  payload: PolicySnapshotPayload,
  signingKey: string,
): Promise<string> {
  return await hmacHex(signingKey, JSON.stringify(payload));
}

export function snapshotAgeSeconds(row: PolicySnapshotRow): number {
  const generated = new Date(row.generated_at).getTime();
  return Math.max(0, Math.floor((Date.now() - generated) / 1000));
}

export function isStale(row: PolicySnapshotRow): boolean {
  return snapshotAgeSeconds(row) > row.max_stale_seconds;
}

/**
 * Load the latest snapshot for an org. Uses a 60s in-memory TTL and falls
 * back to the last cached copy if the DB read errors — that is precisely
 * the failure mode this module exists for.
 */
export async function loadSnapshot(
  supabase: any,
  orgId: string,
  signingKey: string,
): Promise<PolicySnapshotRow | null> {
  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < SOFT_TTL_MS) {
    return cached.row;
  }

  try {
    const { data, error } = await supabase
      .from("policy_snapshots")
      .select("version, generated_at, max_stale_seconds, signature, payload")
      .eq("org_id", orgId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return cached?.row ?? null;

    const row = data as PolicySnapshotRow;
    if (signingKey && !(await verifySnapshotSignature(row, signingKey))) {
      console.error(`[policy-cache] rejecting snapshot v${row.version} for org ${orgId}: bad signature`);
      return cached?.row ?? null;
    }
    cache.set(orgId, { row, fetchedAt: Date.now() });
    return row;
  } catch (e) {
    console.warn(`[policy-cache] refresh failed for org ${orgId}, using last cached copy:`, e);
    return cached?.row ?? null;
  }
}

export function findTask(
  row: PolicySnapshotRow,
  taskKey: string,
): TaskSnapshot | null {
  return row.payload.tasks.find((t) => t.key === taskKey && t.is_active) ?? null;
}

export type DegradationOutcome =
  | { allow: true; reason: "cache_fresh" | "fail_open"; ageSeconds: number; version: number }
  | { allow: false; reason: "no_cache" | "no_task" | "stale_strict" | "stale_standard" | "qps_cap_exceeded"; status: number; ageSeconds: number };

/**
 * Apply the decision matrix in docs/degradation.md.
 */
export function decideDegradedRequest(
  snapshot: PolicySnapshotRow | null,
  taskKey: string,
): DegradationOutcome {
  if (!snapshot) {
    return { allow: false, reason: "no_cache", status: 503, ageSeconds: 0 };
  }
  const age = snapshotAgeSeconds(snapshot);
  const task = findTask(snapshot, taskKey);
  if (!task) {
    return { allow: false, reason: "no_task", status: 503, ageSeconds: age };
  }
  const stale = isStale(snapshot);
  if (!stale) {
    return { allow: true, reason: "cache_fresh", ageSeconds: age, version: snapshot.version };
  }
  // Stale from here on.
  if (task.sensitivity === "strict") {
    return { allow: false, reason: "stale_strict", status: 503, ageSeconds: age };
  }
  if (task.fail_mode === "open") {
    if (task.degraded_qps_cap && !consumeDegradedToken(task.id, task.degraded_qps_cap)) {
      return { allow: false, reason: "qps_cap_exceeded", status: 503, ageSeconds: age };
    }
    return { allow: true, reason: "fail_open", ageSeconds: age, version: snapshot.version };
  }
  return { allow: false, reason: "stale_standard", status: 503, ageSeconds: age };
}

function consumeDegradedToken(taskId: string, cap: number): boolean {
  const now = Date.now();
  const bucket = degradedBuckets.get(taskId);
  if (!bucket || now - bucket.windowStart >= 1000) {
    degradedBuckets.set(taskId, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= cap) return false;
  bucket.count += 1;
  return true;
}

export function degradedResponseHeaders(row: PolicySnapshotRow, mode: "cache" | "fail_open"): Record<string, string> {
  return {
    "X-Enforcement-Mode": "degraded",
    "X-Degradation-Reason": mode,
    "X-Policy-Snapshot-Age": String(snapshotAgeSeconds(row)),
    "X-Policy-Snapshot-Version": String(row.version),
  };
}

// Test hook — do not use in production paths.
export function __resetPolicyCacheForTests(): void {
  cache.clear();
  degradedBuckets.clear();
}
