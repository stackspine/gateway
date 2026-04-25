/**
 * @fileoverview Real-time cost optimization engine
 * Predicts token usage and selects the cheapest qualifying model when confidence is high enough.
 *
 * PATENT NOTICE — Patent 1 (Pending):
 *   Claim 2: Modality-aware predicted-cost projection — implemented via
 *     `projectCallCost()` from ./cost-calculator.ts (called per-route below).
 *   Claim 3: Gating thresholds for auto-routing. The specific composition of
 *     historical-call, qualified-model, success-rate, confidence, and
 *     savings gates that govern route override is the subject of pending
 *     claims; the parameter values are intentionally not enumerated in
 *     comments. See the source code below and the USPTO filings of record
 *     for the authoritative description.
 *   Claim 4: Pre-request optimization runs BEFORE the request is dispatched
 *     to a downstream provider — distinguishing this from post-hoc
 *     analytics-driven model swap recommendations.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { RouteWithProfile } from "./types.ts";
import { projectCallCost, resolveModality } from "./cost-calculator.ts";

export interface CostOptimizationResult {
  optimizedRoute: RouteWithProfile;
  wasOptimized: boolean;
  originalRouteId: string;
  originalModelProfileId: string;
  predictedInputTokens: number;
  predictedOutputTokens: number;
  predictedCostUsd: number;
  confidence: number;
}

interface ModelStats {
  model_profile_id: string;
  total_calls: number;
  total_tokens: number;
  total_cost_usd: number;
}

/**
 * Attempts to optimize route selection for cost. Override only fires when a
 * composition of historical-volume, qualified-model-count, success-rate,
 * confidence, and savings thresholds are simultaneously satisfied; see the
 * implementation below for the operative values.
 *
 * [Patent 1, Claim 3] — The composition of gating thresholds below is the
 *   subject of a pending claim; specific parameter values are not reproduced
 *   in this comment.
 * [Patent 1, Claim 4] — All evaluation occurs pre-request; no payload
 *   leaves the gateway during this function.
 */
export async function optimizeForCost(
  selectedRoute: RouteWithProfile,
  eligibleRoutes: RouteWithProfile[],
  estimatedInputTokens: number,
  taskId: string,
  orgId: string,
  supabase: ReturnType<typeof createClient>,
): Promise<CostOptimizationResult> {
  const originalRouteId = selectedRoute.id;
  const originalModelProfileId = selectedRoute.model_profile_id;

  const noOptResult: CostOptimizationResult = {
    optimizedRoute: selectedRoute,
    wasOptimized: false,
    originalRouteId,
    originalModelProfileId,
    predictedInputTokens: estimatedInputTokens,
    predictedOutputTokens: 0,
    predictedCostUsd: 0,
    confidence: 0,
  };

  if (eligibleRoutes.length < 2) return noOptResult;

  // Get model profile IDs for eligible routes
  const modelProfileIds = [...new Set(eligibleRoutes.map(r => r.model_profile_id))];
  if (modelProfileIds.length < 2) return noOptResult;

  // Query last 7 days of daily_model_stats
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const { data: modelStats } = await supabase
    .from("daily_model_stats")
    .select("model_profile_id, total_calls, total_tokens, total_cost_usd")
    .eq("org_id", orgId)
    .in("model_profile_id", modelProfileIds)
    .gte("date", sevenDaysAgo);

  if (!modelStats || modelStats.length === 0) return noOptResult;

  // Aggregate stats per model
  const statsMap = new Map<string, { totalCalls: number; totalTokens: number; totalCost: number }>();
  for (const row of modelStats as ModelStats[]) {
    const existing = statsMap.get(row.model_profile_id) || { totalCalls: 0, totalTokens: 0, totalCost: 0 };
    existing.totalCalls += row.total_calls;
    existing.totalTokens += Number(row.total_tokens);
    existing.totalCost += Number(row.total_cost_usd);
    statsMap.set(row.model_profile_id, existing);
  }

  // Check minimum data requirements: 50+ calls for at least 2 models
  const qualifiedModels = [...statsMap.entries()].filter(([_, s]) => s.totalCalls >= 50);
  if (qualifiedModels.length < 2) return noOptResult;

  // Get success rates from call_logs for task-specific accuracy
  const { data: successData } = await supabase
    .from("call_logs")
    .select("model_profile_id, status")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .in("model_profile_id", modelProfileIds)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .limit(1000);

  const successRates = new Map<string, number>();
  if (successData) {
    const grouped = new Map<string, { success: number; total: number }>();
    for (const row of successData) {
      const mpId = row.model_profile_id as string;
      const g = grouped.get(mpId) || { success: 0, total: 0 };
      g.total++;
      if (row.status === "success") g.success++;
      grouped.set(mpId, g);
    }
    for (const [mpId, g] of grouped) {
      successRates.set(mpId, g.total > 0 ? g.success / g.total : 0);
    }
  }

  // Project cost for each eligible route
  type CostProjection = {
    route: RouteWithProfile;
    predictedInputTokens: number;
    predictedOutputTokens: number;
    predictedCost: number;
    confidence: number;
    successRate: number;
  };

  const projections: CostProjection[] = [];

  for (const route of eligibleRoutes) {
    const mp = route.model_profiles;
    if (!mp) continue;

    const stats = statsMap.get(mp.id);
    const calls = stats?.totalCalls || 0;
    const avgTokensPerCall = calls > 0 ? stats!.totalTokens / calls : 0;
    const providerType = mp.providers_with_key?.type;
    const modality = resolveModality(mp, providerType);

    // Predict output tokens: use historical avg output/input ratio, capped at 2x.
    // Only meaningful for chat / embedding modalities.
    let predictedOutputTokens: number;
    if ((modality === "chat" || modality === "embedding") && calls >= 10 && avgTokensPerCall > 0) {
      const blendedRate = (Number(mp.cost_per_input_token) || 0) + (Number(mp.cost_per_output_token) || 0);
      const outputRatio = blendedRate > 0 ? (Number(mp.cost_per_output_token) || 0) / blendedRate : 0.5;
      predictedOutputTokens = Math.min(
        Math.round(estimatedInputTokens * (outputRatio > 0 ? outputRatio / (1 - outputRatio) : 1)),
        estimatedInputTokens * 2,
        mp.default_max_tokens || 4096
      );
    } else {
      predictedOutputTokens = Math.min(mp.default_max_tokens || 4096, estimatedInputTokens);
    }

    // Phase 5 — modality-aware predicted USD.
    const predictedCost = projectCallCost(mp, estimatedInputTokens, predictedOutputTokens, providerType);

    const sr = successRates.get(mp.id) ?? 0;
    const confidence = Math.min(calls / 200, 1);

    projections.push({
      route,
      predictedInputTokens: estimatedInputTokens,
      predictedOutputTokens,
      predictedCost,
      confidence,
      successRate: sr,
    });
  }

  if (projections.length < 2) return noOptResult;

  // Find the current route's projection
  const currentProjection = projections.find(p => p.route.id === selectedRoute.id);
  if (!currentProjection) return noOptResult;

  // Sort by predicted cost, filter by success rate ≥ 95%
  const candidates = projections
    .filter(p => p.successRate >= 0.95 && p.confidence >= 0.25)
    .sort((a, b) => a.predictedCost - b.predictedCost);

  if (candidates.length === 0) return noOptResult;

  const cheapest = candidates[0];

  // Only optimize if savings exceed 20%
  if (currentProjection.predictedCost <= 0) return noOptResult;
  const savings = 1 - cheapest.predictedCost / currentProjection.predictedCost;
  if (savings < 0.20) return noOptResult;

  // Don't re-optimize if already the cheapest
  if (cheapest.route.id === selectedRoute.id) return noOptResult;

  return {
    optimizedRoute: cheapest.route,
    wasOptimized: true,
    originalRouteId,
    originalModelProfileId,
    predictedInputTokens: cheapest.predictedInputTokens,
    predictedOutputTokens: cheapest.predictedOutputTokens,
    predictedCostUsd: cheapest.predictedCost,
    confidence: cheapest.confidence,
  };
}

/**
 * Records cost prediction for feedback loop calibration
 */
export async function recordCostPrediction(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  taskId: string,
  callLogId: string | null,
  prediction: CostOptimizationResult,
  actualCostUsd: number | null,
): Promise<void> {
  try {
    await supabase.from("cost_predictions").insert({
      org_id: orgId,
      task_id: taskId,
      call_log_id: callLogId,
      predicted_input_tokens: prediction.predictedInputTokens,
      predicted_output_tokens: prediction.predictedOutputTokens,
      predicted_cost_usd: prediction.predictedCostUsd,
      actual_cost_usd: actualCostUsd,
      model_profile_id: prediction.optimizedRoute.model_profile_id,
      was_optimized: prediction.wasOptimized,
      original_model_profile_id: prediction.wasOptimized ? prediction.originalModelProfileId : null,
      confidence_score: prediction.confidence,
    });
  } catch (e) {
    console.error("Failed to record cost prediction:", e);
  }
}
