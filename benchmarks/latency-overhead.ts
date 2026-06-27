/**
 * Latency overhead micro-benchmark for the StackSpine gateway.
 *
 * Measures the local, CPU-only work the gateway does per request:
 *   - API key SHA-256 hashing + timing-safe comparison
 *   - Pre-flight route/circuit-breaker evaluation
 *   - Cost projection
 *   - Guardrail scans (topic, competitor, profanity)
 *
 * This intentionally excludes the single pre-flight RPC round-trip
 * (documented ~10-30ms) and upstream provider latency, so the number is
 * strictly the gateway's own processing overhead.
 *
 * Run with:
 *   deno run --allow-net --allow-read benchmarks/latency-overhead.ts
 *
 * Reproducibility notes:
 *   - 10,000 iterations, warm-up of 100 iterations.
 *   - Results printed as p50/p95/p99 in milliseconds.
 */

import { timingSafeEqual } from "https://deno.land/std@0.168.0/crypto/timing_safe_equal.ts";
import {
  selectRoute,
} from "../gateway/_shared/routing.ts";
import {
  computeCost,
  projectCallCost,
} from "../gateway/_shared/cost-calculator.ts";
import {
  redactGuardrailMatches,
  scanForCompetitors,
  scanForProfanity,
  scanForTopics,
} from "../gateway/_shared/guardrails.ts";

const WARMUP = 100;
const ITERATIONS = 10_000;

const sampleMessages = [
  { role: "system", content: "You are a helpful assistant." },
  {
    role: "user",
    content: "Summarize this for a CFO: we spent $12,000 on AI infrastructure last month. Contact finance@example.com or call 555-123-4567 for details. Also, do not mention competitors like AcmeAI or OpenAI.",
  },
];

const sampleProfile = {
  modality: "chat",
  cost_per_input_token: 0.000_000_5,
  cost_per_output_token: 0.000_001_5,
} as const;

const sampleRoutes = [
  {
    id: "primary",
    strategy: "primary",
    weight: 80,
    region: null,
    model_profile_id: "m1",
    route_conditions: [],
    model_profiles: {
      id: "m1",
      label: "GPT-4o mini",
      provider_model_name: "gpt-4o-mini",
      default_max_tokens: 1024,
      default_temperature: 0.7,
      cost_per_input_token: 0.000_000_5,
      cost_per_output_token: 0.000_001_5,
      modality: "chat",
      context_window_tokens: 128_000,
      providers_with_key: {
        id: "p1",
        name: "OpenAI",
        type: "openai",
        api_key: "sk-test",
        base_url: null,
        is_active: true,
        consecutive_failures: 0,
        circuit_breaker_threshold: 3,
        circuit_breaker_cooldown_minutes: 5,
        circuit_opened_at: null,
      },
    },
  },
  {
    id: "fallback",
    strategy: "fallback",
    weight: 20,
    region: null,
    model_profile_id: "m2",
    route_conditions: [],
    model_profiles: {
      id: "m2",
      label: "Claude 3 Haiku",
      provider_model_name: "claude-3-haiku",
      default_max_tokens: 1024,
      default_temperature: 0.7,
      cost_per_input_token: 0.000_000_25,
      cost_per_output_token: 0.000_001_25,
      modality: "chat",
      context_window_tokens: 200_000,
      providers_with_key: {
        id: "p2",
        name: "Anthropic",
        type: "anthropic",
        api_key: "sk-test",
        base_url: null,
        is_active: true,
        consecutive_failures: 0,
        circuit_breaker_threshold: 3,
        circuit_breaker_cooldown_minutes: 5,
        circuit_opened_at: null,
      },
    },
  },
];

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

async function runIteration() {
  const start = performance.now();

  // 1. API key hash + compare
  const key = "s***REDACTED-STRIPE-LIVE-KEY***";
  const expectedHash = await hashApiKey(key);
  const actualHash = await hashApiKey(key);
  secureCompare(expectedHash, actualHash);

  // 2. Cost projection
  projectCallCost(sampleProfile, 350, 150, "openai");
  computeCost(sampleProfile, { input_tokens: 350, output_tokens: 150 }, "openai");

  // 3. Route selection + circuit breaker (selectRoute evaluates provider health internally)
  const fullText = sampleMessages.map((m) => m.content).join("\n");
  const routeCtx = {
    metadata: { task_key: "summarize", environment: "production" },
    message_count: sampleMessages.length,
    estimated_tokens: 500,
    time_utc_hour: new Date().getUTCHours(),
    task_key: "summarize",
    region: null,
  };
  selectRoute(sampleRoutes as any, routeCtx as any);

  // 4. Guardrail scans (run each rule type)
  const topicResult = scanForTopics(fullText, ["finance", "CFO", "spending"]);
  const competitorResult = scanForCompetitors(fullText, ["AcmeAI", "OpenAI"]);
  const profanityResult = scanForProfanity(fullText);
  if (topicResult.matched) {
    redactGuardrailMatches(fullText, topicResult.matches);
  }
  if (competitorResult.matched) {
    redactGuardrailMatches(fullText, competitorResult.matches);
  }
  if (profanityResult.matched) {
    redactGuardrailMatches(fullText, profanityResult.matches);
  }

  return performance.now() - start;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function main() {
  // Warm-up
  for (let i = 0; i < WARMUP; i++) {
    await runIteration();
  }

  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    times.push(await runIteration());
  }

  times.sort((a, b) => a - b);

  const stats = {
    iterations: ITERATIONS,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    min: times[0],
    max: times[times.length - 1],
    avg: times.reduce((a, b) => a + b, 0) / times.length,
  };

  console.log("StackSpine Gateway local overhead (micro-benchmark)");
  console.log("====================================================");
  console.log(`Iterations: ${stats.iterations.toLocaleString()}`);
  console.log(`Min:      ${stats.min.toFixed(3)} ms`);
  console.log(`Avg:      ${stats.avg.toFixed(3)} ms`);
  console.log(`p50:      ${stats.p50.toFixed(3)} ms`);
  console.log(`p95:      ${stats.p95.toFixed(3)} ms`);
  console.log(`p99:      ${stats.p99.toFixed(3)} ms`);
  console.log(`Max:      ${stats.max.toFixed(3)} ms`);
  console.log("");
  console.log("Note: this is gateway-local CPU work only.");
  console.log("Add the documented pre-flight RPC round-trip (~10-30 ms) and");
  console.log("upstream provider latency for total per-request latency.");

  // Write JSON artifact for the site to consume if desired.
  await Deno.writeTextFile(
    "benchmarks/latency-overhead.json",
    JSON.stringify(stats, null, 2),
  );
  console.log("Wrote benchmarks/latency-overhead.json");
}

main();
