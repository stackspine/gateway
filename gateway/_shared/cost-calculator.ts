/**
 * @fileoverview Centralized per-modality cost calculator.
 * @module gateway/_shared/cost-calculator
 *
 * Mirror of supabase/functions/invoke/_shared/cost-calculator.ts — keep in sync.
 * See that file for full documentation.
 *
 * PATENT NOTICE — Patent 1 (Pending), Claim 2:
 *   "Modality-aware pre-request cost projection." `resolveModality()` and
 *   `projectCallCost()` together implement the modality discriminator and
 *   per-modality unit pricing required by Claim 2. This is the canonical
 *   point at which a (model_profile, estimated usage) pair is converted to
 *   a USD figure for budget enforcement, route ordering, and post-call
 *   billing. Keep this file as the single source of truth for that logic.
 */

import { PROVIDER_MODALITY } from "./modalities.ts";

export type Modality =
  | "chat"
  | "embedding"
  | "image"
  | "voice_tts"
  | "voice_stt"
  | "search";

export type UnitType =
  | "tokens"
  | "embedding_tokens"
  | "images"
  | "characters"
  | "audio_seconds"
  | "searches";

export interface CostInputs {
  input_tokens?: number;
  output_tokens?: number;
  units?: number;
  unit_type?: string | null;
}

export interface CostableModelProfile {
  modality?: string | null;
  cost_per_input_token?: number | string | null;
  cost_per_output_token?: number | string | null;
  cost_per_image?: number | string | null;
  cost_per_second?: number | string | null;
  cost_per_char?: number | string | null;
  cost_per_search?: number | string | null;
  cost_per_embedding_token?: number | string | null;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

export function resolveModality(
  profile: CostableModelProfile | null | undefined,
  providerType?: string | null,
): Modality {
  const stored = profile?.modality?.toLowerCase();
  if (
    stored === "chat" || stored === "embedding" || stored === "image" ||
    stored === "voice_tts" || stored === "voice_stt" || stored === "search"
  ) {
    return stored as Modality;
  }
  if (providerType && PROVIDER_MODALITY[providerType]) {
    return PROVIDER_MODALITY[providerType] as Modality;
  }
  return "chat";
}

export function computeCost(
  profile: CostableModelProfile | null | undefined,
  inputs: CostInputs,
  providerType?: string | null,
): number {
  if (!profile) return 0;
  const inputTokens = inputs.input_tokens ?? 0;
  const outputTokens = inputs.output_tokens ?? 0;
  const units = inputs.units ?? 0;
  const ut = inputs.unit_type ?? null;

  if (ut === "images") return units * num(profile.cost_per_image);
  if (ut === "characters") return units * num(profile.cost_per_char);
  if (ut === "audio_seconds") return units * num(profile.cost_per_second);
  if (ut === "searches") return units * num(profile.cost_per_search);
  if (ut === "embedding_tokens") {
    const rate = num(profile.cost_per_embedding_token) || num(profile.cost_per_input_token);
    return units * rate;
  }
  if (ut === "tokens" || ut === null || ut === undefined) {
    const modality = resolveModality(profile, providerType);
    if (modality === "embedding") {
      const rate = num(profile.cost_per_embedding_token) || num(profile.cost_per_input_token);
      return (units || inputTokens) * rate;
    }
    return inputTokens * num(profile.cost_per_input_token) +
      outputTokens * num(profile.cost_per_output_token);
  }

  return inputTokens * num(profile.cost_per_input_token) +
    outputTokens * num(profile.cost_per_output_token);
}

export function projectCallCost(
  profile: CostableModelProfile | null | undefined,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
  providerType?: string | null,
): number {
  if (!profile) return 0;
  const modality = resolveModality(profile, providerType);
  switch (modality) {
    case "image":
      return num(profile.cost_per_image);
    case "voice_tts":
      return estimatedInputTokens * 4 * num(profile.cost_per_char);
    case "voice_stt":
      return 0;
    case "search":
      return num(profile.cost_per_search);
    case "embedding": {
      const rate = num(profile.cost_per_embedding_token) || num(profile.cost_per_input_token);
      return estimatedInputTokens * rate;
    }
    case "chat":
    default:
      return estimatedInputTokens * num(profile.cost_per_input_token) +
        estimatedOutputTokens * num(profile.cost_per_output_token);
  }
}
