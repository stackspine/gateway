/**
 * @fileoverview Type definitions for the StackSpine Invoke API
 * @module invoke/_shared/types
 */

/** Request body schema for the invoke endpoint */
export interface InvokeRequest {
  task_key: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  session_id?: string;
  parent_trace_id?: string;
}

export interface RouteConditionRow {
  id: string;
  field: string;
  operator: string;
  value: unknown;
}

export interface RouteDataPolicyRow {
  data_policy_id: string;
  data_policies?: {
    id: string;
    name: string;
    allowed_regions: string[];
    requires_encryption: boolean;
  };
}

export interface RouteWithProfile {
  id: string;
  strategy: string;
  weight: number | null;
  region: string | null;
  model_profile_id: string;
  route_conditions?: RouteConditionRow[];
  route_data_policies?: RouteDataPolicyRow[];
  model_profiles: {
    id: string;
    label: string;
    provider_model_name: string;
    default_max_tokens: number | null;
    default_temperature: number | null;
    cost_per_input_token: number | null;
    cost_per_output_token: number | null;
    /** Phase 5 — per-modality unit prices (nullable; defaults to 0 when missing). */
    cost_per_image?: number | null;
    cost_per_second?: number | null;
    cost_per_char?: number | null;
    cost_per_search?: number | null;
    cost_per_embedding_token?: number | null;
    /** Phase 5 — explicit modality discriminator. Falls back to PROVIDER_MODALITY map. */
    modality?: string | null;
    context_window_tokens: number | null;
    providers_with_key: ProviderData;
  };
}

export interface ProviderData {
  id: string;
  name: string;
  type: string;
  api_key: string | null;
  base_url: string | null;
  is_active: boolean;
  consecutive_failures: number;
  circuit_breaker_threshold: number;
  circuit_breaker_cooldown_minutes: number;
  circuit_opened_at: string | null;
}

/** Runtime context for conditional routing evaluation */
export interface RouteContext {
  metadata: Record<string, unknown>;
  message_count: number;
  estimated_tokens: number;
  time_utc_hour: number;
  task_key: string;
  region: string | null;
  data_policy?: string | null;
}

export interface BudgetEnforcementResult {
  allowed: boolean;
  blockedBy?: string;
  currentSpend?: number;
  limit?: number;
}
