/**
 * @fileoverview Provider API call logic and endpoint configuration
 * @module invoke/_shared/providers
 */

import type { RouteWithProfile } from "./types.ts";

/**
 * AI provider endpoint configurations.
 *
 * All providers below speak the OpenAI chat/completions wire format with
 * Bearer-token auth, except `anthropic` (x-api-key + Messages API) and
 * `google` (x-goog-api-key, handled upstream). They flow through the generic
 * branch in `callProvider()` below, so adding a new OpenAI-compatible host
 * is purely a config addition here.
 *
 * Custom-auth providers (AWS Bedrock SigV4, Azure OpenAI api-version routing,
 * Google Vertex AI service-account JWT, IBM watsonx IAM, Oracle OCI signing)
 * are intentionally NOT in this map — they need dedicated handlers and ship
 * in a later phase.
 */
export const providerEndpoints: Record<string, { url: string; authHeader: string }> = {
  // ── Native non-OpenAI-compatible (custom request/response handling) ────
  openai: { url: "https://api.openai.com/v1/chat/completions", authHeader: "Authorization" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", authHeader: "x-api-key" },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/models", authHeader: "x-goog-api-key" },

  // ── Frontier labs (OpenAI-compatible) ──────────────────────────────────
  xai: { url: "https://api.x.ai/v1/chat/completions", authHeader: "Authorization" },
  ai21: { url: "https://api.ai21.com/studio/v1/chat/completions", authHeader: "Authorization" },
  cohere: { url: "https://api.cohere.com/compatibility/v1/chat/completions", authHeader: "Authorization" },
  mistral: { url: "https://api.mistral.ai/v1/chat/completions", authHeader: "Authorization" },
  deepseek: { url: "https://api.deepseek.com/chat/completions", authHeader: "Authorization" },
  perplexity: { url: "https://api.perplexity.ai/chat/completions", authHeader: "Authorization" },

  // ── Lovable AI Gateway ─────────────────────────────────────────────────
  lovable: { url: "https://ai.gateway.lovable.dev/v1/chat/completions", authHeader: "Authorization" },

  // ── Inference hosts ────────────────────────────────────────────────────
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", authHeader: "Authorization" },
  together: { url: "https://api.together.xyz/v1/chat/completions", authHeader: "Authorization" },
  fireworks: { url: "https://api.fireworks.ai/inference/v1/chat/completions", authHeader: "Authorization" },
  anyscale: { url: "https://api.endpoints.anyscale.com/v1/chat/completions", authHeader: "Authorization" },
  deepinfra: { url: "https://api.deepinfra.com/v1/openai/chat/completions", authHeader: "Authorization" },
  octoai: { url: "https://text.octoai.run/v1/chat/completions", authHeader: "Authorization" },
  runpod: { url: "https://api.runpod.ai/v2/openai/v1/chat/completions", authHeader: "Authorization" },
  novita: { url: "https://api.novita.ai/v3/openai/chat/completions", authHeader: "Authorization" },
  lepton: { url: "https://api.lepton.ai/api/v1/chat/completions", authHeader: "Authorization" },
  sambanova: { url: "https://api.sambanova.ai/v1/chat/completions", authHeader: "Authorization" },
  cerebras: { url: "https://api.cerebras.ai/v1/chat/completions", authHeader: "Authorization" },
  lambda: { url: "https://api.lambdalabs.com/v1/chat/completions", authHeader: "Authorization" },
  hyperbolic: { url: "https://api.hyperbolic.xyz/v1/chat/completions", authHeader: "Authorization" },
  nebius: { url: "https://api.studio.nebius.ai/v1/chat/completions", authHeader: "Authorization" },
  siliconflow: { url: "https://api.siliconflow.cn/v1/chat/completions", authHeader: "Authorization" },
  infermatic: { url: "https://api.totalgpt.ai/v1/chat/completions", authHeader: "Authorization" },
  kluster: { url: "https://api.kluster.ai/v1/chat/completions", authHeader: "Authorization" },
  nscale: { url: "https://inference.api.nscale.com/v1/chat/completions", authHeader: "Authorization" },
  featherless: { url: "https://api.featherless.ai/v1/chat/completions", authHeader: "Authorization" },
  chutes: { url: "https://llm.chutes.ai/v1/chat/completions", authHeader: "Authorization" },
  crusoe: { url: "https://api.crusoe.ai/v1/chat/completions", authHeader: "Authorization" },
  atoma: { url: "https://api.atoma.network/v1/chat/completions", authHeader: "Authorization" },
  friendliai: { url: "https://inference.friendli.ai/v1/chat/completions", authHeader: "Authorization" },

  // ── Open-source self-hosted (base_url override is REQUIRED in production) ─
  huggingface: { url: "https://api-inference.huggingface.co/v1/chat/completions", authHeader: "Authorization" },
  ollama: { url: "http://localhost:11434/v1/chat/completions", authHeader: "Authorization" },
  vllm: { url: "http://localhost:8000/v1/chat/completions", authHeader: "Authorization" },
  tgi: { url: "http://localhost:8080/v1/chat/completions", authHeader: "Authorization" },
  lmstudio: { url: "http://localhost:1234/v1/chat/completions", authHeader: "Authorization" },
  llamacpp: { url: "http://localhost:8080/v1/chat/completions", authHeader: "Authorization" },
  openllm: { url: "http://localhost:3000/v1/chat/completions", authHeader: "Authorization" },
  tabbyapi: { url: "http://localhost:5000/v1/chat/completions", authHeader: "Authorization" },

  // ── Chinese cloud LLMs (OpenAI-compatible mode) ───────────────────────
  alibaba_dashscope: { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", authHeader: "Authorization" },
  tencent_hunyuan: { url: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions", authHeader: "Authorization" },
  baidu_ernie: { url: "https://qianfan.baidubce.com/v2/chat/completions", authHeader: "Authorization" },
  zhipu_glm: { url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", authHeader: "Authorization" },
  moonshot: { url: "https://api.moonshot.cn/v1/chat/completions", authHeader: "Authorization" },
  minimax: { url: "https://api.minimax.chat/v1/text/chatcompletion_v2", authHeader: "Authorization" },
  stepfun: { url: "https://api.stepfun.com/v1/chat/completions", authHeader: "Authorization" },
  yi_01ai: { url: "https://api.lingyiwanwu.com/v1/chat/completions", authHeader: "Authorization" },

  // ── Specialty / enterprise (OpenAI-compatible) ────────────────────────
  writer: { url: "https://api.writer.com/v1/chat", authHeader: "Authorization" },
  databricks: { url: "https://workspace.cloud.databricks.com/serving-endpoints/chat/completions", authHeader: "Authorization" },
  predibase: { url: "https://serving.app.predibase.com/v1/chat/completions", authHeader: "Authorization" },
  baseten: { url: "https://app.baseten.co/v1/chat/completions", authHeader: "Authorization" },

  // ── Aggregator routers (passthrough — for migration scenarios) ────────
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", authHeader: "Authorization" },
  requesty: { url: "https://router.requesty.ai/v1/chat/completions", authHeader: "Authorization" },
  portkey: { url: "https://api.portkey.ai/v1/chat/completions", authHeader: "Authorization" },
  litellm: { url: "http://localhost:4000/v1/chat/completions", authHeader: "Authorization" },

  // ── Bring-your-own / catch-all ────────────────────────────────────────
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
