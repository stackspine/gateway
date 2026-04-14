/**
 * @fileoverview Provider API call logic and endpoint configuration
 * @module invoke/_shared/providers
 */

import type { RouteWithProfile } from "./types.ts";

/** AI provider endpoint configurations */
export const providerEndpoints: Record<string, { url: string; authHeader: string }> = {
  openai: { url: "https://api.openai.com/v1/chat/completions", authHeader: "Authorization" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", authHeader: "x-api-key" },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/models", authHeader: "x-goog-api-key" },
  lovable: { url: "https://ai.gateway.lovable.dev/v1/chat/completions", authHeader: "Authorization" },
  perplexity: { url: "https://api.perplexity.ai/chat/completions", authHeader: "Authorization" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", authHeader: "Authorization" },
  mistral: { url: "https://api.mistral.ai/v1/chat/completions", authHeader: "Authorization" },
  together: { url: "https://api.together.xyz/v1/chat/completions", authHeader: "Authorization" },
  fireworks: { url: "https://api.fireworks.ai/inference/v1/chat/completions", authHeader: "Authorization" },
  deepseek: { url: "https://api.deepseek.com/chat/completions", authHeader: "Authorization" },
  custom_http: { url: "", authHeader: "Authorization" },
};

/**
 * Make an API call to an AI provider.
 * Handles provider-specific request/response formatting.
 */
export async function callProvider(
  provider: RouteWithProfile["model_profiles"]["providers_with_key"],
  modelProfile: RouteWithProfile["model_profiles"],
  fullMessages: Array<{ role: string; content: string }>,
  systemPrompt: string | null,
  maxTokens: number | null,
  temperature: number | null,
  stream: boolean,
  lovableApiKey: string | undefined
): Promise<{ ok: boolean; status: number; data?: unknown; errorText?: string; response?: Response }> {
  const providerConfig = providerEndpoints[provider.type] || providerEndpoints.openai;
  const baseUrl = provider.base_url || providerConfig.url;

  let providerApiKey = (provider as Record<string, unknown>).api_key || provider.api_key_encrypted;
  if (provider.type === "lovable" && lovableApiKey) {
    providerApiKey = lovableApiKey;
  }

  if (!providerApiKey) {
    return { ok: false, status: 500, errorText: "Provider API key not configured" };
  }

  let requestBody: Record<string, unknown>;
  let headers: Record<string, string>;

  if (provider.type === "anthropic") {
    requestBody = {
      model: modelProfile.provider_model_name,
      max_tokens: maxTokens || modelProfile.default_max_tokens || 4096,
      messages: fullMessages.filter((m) => m.role !== "system"),
      system: systemPrompt || undefined,
    };
    headers = {
      "x-api-key": providerApiKey,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
  } else {
    requestBody = {
      model: modelProfile.provider_model_name,
      messages: fullMessages,
      max_tokens: maxTokens || modelProfile.default_max_tokens || 4096,
      temperature: temperature ?? modelProfile.default_temperature ?? 0.7,
      stream,
    };
    headers = {
      Authorization: `Bearer ${providerApiKey}`,
      "Content-Type": "application/json",
    };
  }

  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, status: response.status, errorText };
    }

    if (stream) return { ok: true, status: 200, response };

    const data = await response.json();
    return { ok: true, status: 200, data };
  } catch (error) {
    return { ok: false, status: 500, errorText: error instanceof Error ? error.message : "Network error" };
  }
}
