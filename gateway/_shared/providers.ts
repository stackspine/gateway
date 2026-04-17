/**
 * @fileoverview Provider API call logic and endpoint configuration
 * @module invoke/_shared/providers
 */

import type { RouteWithProfile } from "./types.ts";
import { parseAwsCredentials, signSigV4 } from "./sigv4.ts";
import { getGcpAccessToken } from "./gcp-jwt.ts";
import { getIbmIamToken } from "./ibm-iam.ts";
import { parseOciCredentials, signOciRequest } from "./oci-sign.ts";

/**
 * AI provider endpoint configurations.
 *
 * Most providers below speak the OpenAI chat/completions wire format with
 * Bearer-token auth. Exceptions handled with dedicated branches in
 * `callProvider()`:
 *   - `anthropic`    : x-api-key + Messages API
 *   - `google`       : x-goog-api-key (handled upstream)
 *   - `aws_bedrock`  : SigV4 signing, Anthropic-on-Bedrock body shape
 *   - `azure_openai` : deployment-name URL + api-version query + api-key header
 *   - `google_vertex`: GCP service-account JWT exchange (Anthropic-on-Vertex body)
 *   - `ibm_watsonx`  : IBM Cloud IAM token exchange (text/chat generation)
 *   - `oracle_oci`   : OCI Signature v1 request signing (Generative AI inference)
 */
export const providerEndpoints: Record<string, { url: string; authHeader: string }> = {
  // ── Native non-OpenAI-compatible (custom request/response handling) ────
  openai: { url: "https://api.openai.com/v1/chat/completions", authHeader: "Authorization" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", authHeader: "x-api-key" },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/models", authHeader: "x-goog-api-key" },
  aws_bedrock: { url: "", authHeader: "Authorization" }, // base_url=bedrock://{region}
  azure_openai: { url: "", authHeader: "api-key" }, // base_url=full Azure deployment URL
  google_vertex: { url: "", authHeader: "Authorization" }, // base_url=vertex://{project}/{region}; api_key=service-account JSON
  ibm_watsonx: { url: "", authHeader: "Authorization" }, // base_url=https://{region}.ml.cloud.ibm.com|<project_id>; api_key=IBM Cloud API key
  oracle_oci: { url: "", authHeader: "Authorization" }, // base_url=oci://{compartment_ocid}; api_key=tenancy:user:fingerprint:region:base64_pkcs8_key

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

  // ── AWS Bedrock: SigV4 signing, Anthropic-on-Bedrock body shape ──────
  if (provider.type === "aws_bedrock") {
    return await callBedrock(
      provider,
      modelProfile,
      fullMessages,
      systemPrompt,
      maxTokens,
      providerApiKey as string,
    );
  }

  // ── Azure OpenAI: deployment URL + api-key header (no Bearer) ────────
  if (provider.type === "azure_openai") {
    return await callAzure(
      baseUrl,
      modelProfile,
      fullMessages,
      maxTokens,
      temperature,
      stream,
      providerApiKey as string,
    );
  }

  // ── Google Vertex AI: service-account JWT → OAuth token ──────────────
  if (provider.type === "google_vertex") {
    return await callVertex(
      provider,
      modelProfile,
      fullMessages,
      systemPrompt,
      maxTokens,
      providerApiKey as string,
    );
  }

  // ── IBM watsonx.ai: IAM token exchange + ML text-generation API ──────
  if (provider.type === "ibm_watsonx") {
    return await callWatsonx(
      provider,
      modelProfile,
      fullMessages,
      systemPrompt,
      maxTokens,
      temperature,
      providerApiKey as string,
    );
  }

  // ── Oracle OCI Generative AI: OCI Signature v1 ────────────────────────
  if (provider.type === "oracle_oci") {
    return await callOci(
      provider,
      modelProfile,
      fullMessages,
      systemPrompt,
      maxTokens,
      temperature,
      providerApiKey as string,
    );
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

/**
 * Invoke an AWS Bedrock foundation model via SigV4-signed POST to
 * bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke.
 *
 * Provider config convention:
 *   base_url           = "bedrock://{region}"  (e.g. "bedrock://us-east-1")
 *   api_key_encrypted  = "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]"
 *   provider_model_name = full Bedrock model id (e.g. "anthropic.claude-3-5-sonnet-20241022-v2:0")
 *
 * Currently emits the Anthropic-on-Bedrock body shape (works for all
 * `anthropic.*` model ids — the dominant Bedrock use case). Other model
 * families (Cohere, Meta Llama, AI21) will need their own branches; until
 * then they'll get a clear error rather than a silently-wrong call.
 *
 * Streaming is not yet wired for Bedrock — falls back to non-streaming.
 */
async function callBedrock(
  provider: RouteWithProfile["model_profiles"]["providers_with_key"],
  modelProfile: RouteWithProfile["model_profiles"],
  fullMessages: Array<{ role: string; content: string }>,
  systemPrompt: string | null,
  maxTokens: number | null,
  apiKey: string,
): Promise<{ ok: boolean; status: number; data?: unknown; errorText?: string; response?: Response }> {
  try {
    const baseUrl = provider.base_url || "";
    if (!baseUrl.startsWith("bedrock://")) {
      return {
        ok: false,
        status: 500,
        errorText:
          'Bedrock provider base_url must be formatted as "bedrock://{region}", e.g. "bedrock://us-east-1"',
      };
    }
    const region = baseUrl.replace("bedrock://", "").trim();
    if (!region) {
      return { ok: false, status: 500, errorText: "Bedrock region missing in base_url" };
    }

    const modelId = modelProfile.provider_model_name;
    const isAnthropic = modelId.startsWith("anthropic.");
    if (!isAnthropic) {
      return {
        ok: false,
        status: 501,
        errorText: `Bedrock model family not yet supported: ${modelId}. Currently only anthropic.* models are wired.`,
      };
    }

    const creds = parseAwsCredentials(apiKey);
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;

    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens || modelProfile.default_max_tokens || 4096,
      messages: fullMessages.filter((m) => m.role !== "system"),
      system: systemPrompt || undefined,
    });

    const signedHeaders = await signSigV4({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      region,
      service: "bedrock",
      method: "POST",
      url,
      body,
      headers: { "content-type": "application/json", accept: "application/json" },
    });

    const response = await fetch(url, { method: "POST", headers: signedHeaders, body });
    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, status: response.status, errorText };
    }

    const raw = await response.json() as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };

    // Normalize Anthropic-on-Bedrock response to OpenAI chat.completions shape
    // so downstream parsing in invoke/index.ts continues to work uniformly.
    const text = (raw.content || []).map((c) => c.text || "").join("");
    const normalized = {
      id: `bedrock-${Date.now()}`,
      object: "chat.completion",
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: raw.stop_reason || "stop",
        },
      ],
      usage: {
        prompt_tokens: raw.usage?.input_tokens ?? 0,
        completion_tokens: raw.usage?.output_tokens ?? 0,
        total_tokens: (raw.usage?.input_tokens ?? 0) + (raw.usage?.output_tokens ?? 0),
      },
    };

    return { ok: true, status: 200, data: normalized };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      errorText: error instanceof Error ? error.message : "Bedrock call failed",
    };
  }
}

/**
 * Invoke an Azure OpenAI deployment.
 *
 * Provider config convention:
 *   base_url = full deployment URL with api-version, e.g.
 *     "https://my-resource.openai.azure.com/openai/deployments/my-gpt4o/chat/completions?api-version=2024-10-21"
 *   api_key_encrypted = the Azure resource key
 *   provider_model_name = ignored by Azure (deployment name lives in URL); we
 *                         still pass it as `model` for log fidelity.
 *
 * Body shape and response shape are OpenAI-compatible, so no normalization
 * is needed beyond auth-header swap.
 */
async function callAzure(
  baseUrl: string,
  modelProfile: RouteWithProfile["model_profiles"],
  fullMessages: Array<{ role: string; content: string }>,
  maxTokens: number | null,
  temperature: number | null,
  stream: boolean,
  apiKey: string,
): Promise<{ ok: boolean; status: number; data?: unknown; errorText?: string; response?: Response }> {
  try {
    if (!baseUrl || !baseUrl.includes("api-version=")) {
      return {
        ok: false,
        status: 500,
        errorText:
          'Azure provider base_url must be the full deployment URL including ?api-version=YYYY-MM-DD, e.g. "https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=2024-10-21"',
      };
    }

    const requestBody: Record<string, unknown> = {
      model: modelProfile.provider_model_name,
      messages: fullMessages,
      max_tokens: maxTokens || modelProfile.default_max_tokens || 4096,
      temperature: temperature ?? modelProfile.default_temperature ?? 0.7,
      stream,
    };

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
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
    return {
      ok: false,
      status: 500,
      errorText: error instanceof Error ? error.message : "Azure call failed",
    };
  }
}

/**
 * Invoke Anthropic Claude on Google Vertex AI.
 *
 * Provider config convention:
 *   base_url            = "vertex://{project_id}/{region}"
 *                         (e.g. "vertex://my-gcp-proj/us-east5")
 *   api_key_encrypted   = full service-account JSON (single line, escaped)
 *   provider_model_name = Vertex publisher model id
 *                         (e.g. "claude-3-5-sonnet-v2@20241022")
 *
 * Currently only Anthropic publisher models are wired (the dominant Vertex
 * use case for this gateway). Gemini/PaLM go through the existing `google`
 * provider on Generative Language API.
 */
async function callVertex(
  provider: RouteWithProfile["model_profiles"]["providers_with_key"],
  modelProfile: RouteWithProfile["model_profiles"],
  fullMessages: Array<{ role: string; content: string }>,
  systemPrompt: string | null,
  maxTokens: number | null,
  apiKey: string,
): Promise<{ ok: boolean; status: number; data?: unknown; errorText?: string; response?: Response }> {
  try {
    const baseUrl = provider.base_url || "";
    if (!baseUrl.startsWith("vertex://")) {
      return {
        ok: false,
        status: 500,
        errorText:
          'Vertex provider base_url must be formatted as "vertex://{project_id}/{region}", e.g. "vertex://my-proj/us-east5"',
      };
    }
    const stripped = baseUrl.replace("vertex://", "");
    const [projectId, region] = stripped.split("/");
    if (!projectId || !region) {
      return { ok: false, status: 500, errorText: "Vertex base_url must include both project and region" };
    }

    const modelId = modelProfile.provider_model_name;
    if (!modelId.startsWith("claude-")) {
      return {
        ok: false,
        status: 501,
        errorText: `Vertex model family not yet supported: ${modelId}. Currently only claude-* publisher models are wired. Gemini models should use the 'google' provider type.`,
      };
    }

    const accessToken = await getGcpAccessToken(apiKey);
    const url =
      `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${encodeURIComponent(modelId)}:rawPredict`;

    const body = JSON.stringify({
      anthropic_version: "vertex-2023-10-16",
      max_tokens: maxTokens || modelProfile.default_max_tokens || 4096,
      messages: fullMessages.filter((m) => m.role !== "system"),
      system: systemPrompt || undefined,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, status: response.status, errorText };
    }

    const raw = await response.json() as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };

    const text = (raw.content || []).map((c) => c.text || "").join("");
    const normalized = {
      id: `vertex-${Date.now()}`,
      object: "chat.completion",
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: raw.stop_reason || "stop",
        },
      ],
      usage: {
        prompt_tokens: raw.usage?.input_tokens ?? 0,
        completion_tokens: raw.usage?.output_tokens ?? 0,
        total_tokens: (raw.usage?.input_tokens ?? 0) + (raw.usage?.output_tokens ?? 0),
      },
    };

    return { ok: true, status: 200, data: normalized };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      errorText: error instanceof Error ? error.message : "Vertex call failed",
    };
  }
}

/**
 * Invoke an IBM watsonx.ai foundation model via the v1 text-generation API.
 *
 * Provider config convention:
 *   base_url            = "{region_host}|{project_id}"
 *                         (e.g. "https://us-south.ml.cloud.ibm.com|abc-123-def")
 *   api_key_encrypted   = IBM Cloud API key
 *   provider_model_name = watsonx model id
 *                         (e.g. "ibm/granite-13b-chat-v2", "meta-llama/llama-3-70b-instruct")
 *
 * watsonx exposes a non-OpenAI generation API. We flatten chat messages into
 * a single prompt (system + alternating user/assistant turns) and normalize
 * the response to OpenAI chat.completions shape.
 */
async function callWatsonx(
  provider: RouteWithProfile["model_profiles"]["providers_with_key"],
  modelProfile: RouteWithProfile["model_profiles"],
  fullMessages: Array<{ role: string; content: string }>,
  systemPrompt: string | null,
  maxTokens: number | null,
  temperature: number | null,
  apiKey: string,
): Promise<{ ok: boolean; status: number; data?: unknown; errorText?: string; response?: Response }> {
  try {
    const baseUrl = provider.base_url || "";
    const sep = baseUrl.indexOf("|");
    if (sep === -1) {
      return {
        ok: false,
        status: 500,
        errorText:
          'watsonx provider base_url must be formatted as "{region_host}|{project_id}", e.g. "https://us-south.ml.cloud.ibm.com|abc-123-def"',
      };
    }
    const regionHost = baseUrl.slice(0, sep).replace(/\/$/, "");
    const projectId = baseUrl.slice(sep + 1).trim();
    if (!regionHost || !projectId) {
      return { ok: false, status: 500, errorText: "watsonx base_url missing region or project_id" };
    }

    const iamToken = await getIbmIamToken(apiKey);
    const url = `${regionHost}/ml/v1/text/generation?version=2024-05-31`;

    // Flatten messages → prompt
    const prefix = systemPrompt ? `System: ${systemPrompt}\n\n` : "";
    const turns = fullMessages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
      .join("\n\n");
    const prompt = `${prefix}${turns}\n\nAssistant:`;

    const body = JSON.stringify({
      model_id: modelProfile.provider_model_name,
      project_id: projectId,
      input: prompt,
      parameters: {
        decoding_method: "greedy",
        max_new_tokens: maxTokens || modelProfile.default_max_tokens || 1024,
        temperature: temperature ?? modelProfile.default_temperature ?? 0.7,
      },
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${iamToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, status: response.status, errorText };
    }

    const raw = await response.json() as {
      results?: Array<{
        generated_text?: string;
        input_token_count?: number;
        generated_token_count?: number;
        stop_reason?: string;
      }>;
    };
    const r = raw.results?.[0];
    const text = r?.generated_text || "";
    const inputTok = r?.input_token_count ?? 0;
    const outputTok = r?.generated_token_count ?? 0;

    const normalized = {
      id: `watsonx-${Date.now()}`,
      object: "chat.completion",
      model: modelProfile.provider_model_name,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: r?.stop_reason || "stop",
        },
      ],
      usage: {
        prompt_tokens: inputTok,
        completion_tokens: outputTok,
        total_tokens: inputTok + outputTok,
      },
    };

    return { ok: true, status: 200, data: normalized };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      errorText: error instanceof Error ? error.message : "watsonx call failed",
    };
  }
}

/**
 * Invoke an Oracle OCI Generative AI on-demand chat model.
 *
 * Provider config convention:
 *   base_url            = "oci://{compartment_ocid}"
 *                         (e.g. "oci://ocid1.compartment.oc1..aaa...")
 *   api_key_encrypted   = "{tenancy_ocid}:{user_ocid}:{key_fingerprint}:{region}:{base64_pkcs8_private_key}"
 *   provider_model_name = OCI on-demand model id
 *                         (e.g. "cohere.command-r-plus-08-2024", "meta.llama-3.1-405b-instruct")
 *
 * Endpoint:
 *   POST https://inference.generativeai.{region}.oci.oraclecloud.com/20231130/actions/chat
 */
async function callOci(
  provider: RouteWithProfile["model_profiles"]["providers_with_key"],
  modelProfile: RouteWithProfile["model_profiles"],
  fullMessages: Array<{ role: string; content: string }>,
  systemPrompt: string | null,
  maxTokens: number | null,
  temperature: number | null,
  apiKey: string,
): Promise<{ ok: boolean; status: number; data?: unknown; errorText?: string; response?: Response }> {
  try {
    const baseUrl = provider.base_url || "";
    if (!baseUrl.startsWith("oci://")) {
      return {
        ok: false,
        status: 500,
        errorText:
          'OCI provider base_url must be formatted as "oci://{compartment_ocid}", e.g. "oci://ocid1.compartment.oc1..aaa..."',
      };
    }
    const compartmentId = baseUrl.replace("oci://", "").trim();
    if (!compartmentId) {
      return { ok: false, status: 500, errorText: "OCI compartment OCID missing in base_url" };
    }

    const creds = parseOciCredentials(apiKey);
    const url = `https://inference.generativeai.${creds.region}.oci.oraclecloud.com/20231130/actions/chat`;

    // OCI Generative AI generic chat request shape (works for cohere.* and meta.*)
    const messages = systemPrompt
      ? [{ role: "SYSTEM", content: [{ type: "TEXT", text: systemPrompt }] }, ...fullMessages.filter((m) => m.role !== "system").map((m) => ({
          role: m.role === "assistant" ? "ASSISTANT" : "USER",
          content: [{ type: "TEXT", text: m.content }],
        }))]
      : fullMessages.map((m) => ({
          role: m.role === "assistant" ? "ASSISTANT" : (m.role === "system" ? "SYSTEM" : "USER"),
          content: [{ type: "TEXT", text: m.content }],
        }));

    const body = JSON.stringify({
      compartmentId,
      servingMode: { servingType: "ON_DEMAND", modelId: modelProfile.provider_model_name },
      chatRequest: {
        apiFormat: "GENERIC",
        messages,
        maxTokens: maxTokens || modelProfile.default_max_tokens || 1024,
        temperature: temperature ?? modelProfile.default_temperature ?? 0.7,
      },
    });

    const headers = await signOciRequest({ creds, method: "POST", url, body });
    const response = await fetch(url, { method: "POST", headers, body });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, status: response.status, errorText };
    }

    const raw = await response.json() as {
      chatResponse?: {
        choices?: Array<{
          message?: { content?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      };
    };
    const choice = raw.chatResponse?.choices?.[0];
    const text = (choice?.message?.content || []).map((c) => c.text || "").join("");

    const normalized = {
      id: `oci-${Date.now()}`,
      object: "chat.completion",
      model: modelProfile.provider_model_name,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: choice?.finishReason || "stop",
        },
      ],
      usage: {
        prompt_tokens: raw.chatResponse?.usage?.promptTokens ?? 0,
        completion_tokens: raw.chatResponse?.usage?.completionTokens ?? 0,
        total_tokens: raw.chatResponse?.usage?.totalTokens ?? 0,
      },
    };

    return { ok: true, status: 200, data: normalized };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      errorText: error instanceof Error ? error.message : "OCI call failed",
    };
  }
}
