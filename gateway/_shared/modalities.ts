/**
 * @fileoverview Non-chat modality handlers (embeddings, image, voice, search).
 * @module invoke/_shared/modalities
 *
 * Each handler:
 *   1. Reads the user's prompt from `fullMessages` (last user message text)
 *      OR from a structured `metadata.modality_input` blob if the caller
 *      supplied richer parameters (image size, voice id, etc.).
 *   2. Calls the provider's native endpoint.
 *   3. Normalizes the response into a chat-completions-shaped envelope so
 *      the existing logging/billing/dashboards continue to work unchanged.
 *      The envelope adds:
 *        - `units`     : number consumed (images, seconds, characters, searches, tokens)
 *        - `unit_type` : matches tasks.unit_type
 *        - `modality`  : echoes the dispatched modality
 *
 * All handlers share the same return contract used by `callProvider()`:
 *   { ok, status, data?, errorText?, response? }
 *
 * This file implements behavior subject to pending US patent applications;
 * see gateway-oss/NOTICE.
 */

import type { RouteWithProfile } from "./types.ts";

type Provider = RouteWithProfile["model_profiles"]["providers_with_key"];
type ModelProfile = RouteWithProfile["model_profiles"];
export type ModalityResult = {
  ok: boolean;
  status: number;
  data?: unknown;
  errorText?: string;
  response?: Response;
};

// ─────────────────────────────────────────────────────────────────────────
//  Provider → modality map. Used by the dispatcher in providers.ts.
// ─────────────────────────────────────────────────────────────────────────

export const PROVIDER_MODALITY: Record<
  string,
  "embedding" | "image" | "voice_tts" | "voice_stt" | "search"
> = {
  // Embeddings
  voyage: "embedding",
  jina: "embedding",
  cohere_embed: "embedding",
  mixedbread: "embedding",
  nomic: "embedding",
  openai_embed: "embedding",
  // Image generation
  stability: "image",
  ideogram: "image",
  black_forest_labs: "image",
  recraft: "image",
  luma: "image",
  runway: "image",
  leonardo: "image",
  dall_e: "image",
  // Voice — text→speech
  elevenlabs: "voice_tts",
  cartesia: "voice_tts",
  playht: "voice_tts",
  resemble: "voice_tts",
  lmnt: "voice_tts",
  hume: "voice_tts",
  openai_tts: "voice_tts",
  // Voice — speech→text
  deepgram: "voice_stt",
  assemblyai: "voice_stt",
  rev_ai: "voice_stt",
  speechmatics: "voice_stt",
  openai_whisper: "voice_stt",
  // Search
  tavily: "search",
  exa: "search",
  serper: "search",
  brave_search: "search",
  you_com: "search",
  perplexity_sonar: "search",
  kagi: "search",
  valyu: "search",
};

/** Pull last user-role message text — the canonical "prompt" across modalities. */
function lastUserPrompt(
  messages: Array<{ role: string; content: string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content || "";
  }
  return messages[messages.length - 1]?.content || "";
}

/** Wrap a modality result in a chat-completion-shaped envelope so existing
 *  pipeline code (logging, streaming preface, callbacks) keeps working. */
function envelope(opts: {
  modality: string;
  modelName: string;
  text: string;
  units: number;
  unitType: string;
  raw?: unknown;
}) {
  return {
    id: `${opts.modality}-${Date.now()}`,
    object: "modality.completion",
    model: opts.modelName,
    modality: opts.modality,
    units: opts.units,
    unit_type: opts.unitType,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: opts.text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      units: opts.units,
      unit_type: opts.unitType,
    },
    raw: opts.raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  EMBEDDINGS
// ─────────────────────────────────────────────────────────────────────────

const EMBED_ENDPOINTS: Record<string, { url: string; authHeader: string }> = {
  openai_embed: {
    url: "https://api.openai.com/v1/embeddings",
    authHeader: "Authorization",
  },
  voyage: {
    url: "https://api.voyageai.com/v1/embeddings",
    authHeader: "Authorization",
  },
  jina: {
    url: "https://api.jina.ai/v1/embeddings",
    authHeader: "Authorization",
  },
  cohere_embed: {
    url: "https://api.cohere.com/v2/embed",
    authHeader: "Authorization",
  },
  mixedbread: {
    url: "https://api.mixedbread.ai/v1/embeddings",
    authHeader: "Authorization",
  },
  nomic: {
    url: "https://api-atlas.nomic.ai/v1/embedding/text",
    authHeader: "Authorization",
  },
};

export async function callEmbedding(
  provider: Provider,
  modelProfile: ModelProfile,
  fullMessages: Array<{ role: string; content: string }>,
  apiKey: string,
): Promise<ModalityResult> {
  const cfg = EMBED_ENDPOINTS[provider.type];
  if (!cfg) {
    return {
      ok: false,
      status: 501,
      errorText: `Embedding provider not wired: ${provider.type}`,
    };
  }
  const url = provider.base_url || cfg.url;
  const input = lastUserPrompt(fullMessages);
  const model = modelProfile.provider_model_name;

  // Provider-specific body shapes
  let body: string;
  if (provider.type === "cohere_embed") {
    body = JSON.stringify({
      model,
      texts: [input],
      input_type: "search_document",
    });
  } else if (provider.type === "nomic") {
    body = JSON.stringify({
      model,
      texts: [input],
      task_type: "search_document",
    });
  } else {
    body = JSON.stringify({ model, input });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        [cfg.authHeader]: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorText: await response.text(),
      };
    }
    const raw = await response.json() as Record<string, unknown>;

    // Extract vector + token count across providers
    let vector: number[] = [];
    let tokens = 0;
    if (provider.type === "cohere_embed") {
      const e = (raw as { embeddings?: { float?: number[][] } }).embeddings;
      vector = e?.float?.[0] || [];
      tokens = (raw as { meta?: { billed_units?: { input_tokens?: number } } })
        .meta?.billed_units?.input_tokens ?? 0;
    } else if (provider.type === "nomic") {
      const arr = (raw as { embeddings?: number[][] }).embeddings;
      vector = arr?.[0] || [];
      tokens =
        (raw as { usage?: { total_tokens?: number } }).usage?.total_tokens ?? 0;
    } else {
      // OpenAI-shape (openai_embed, voyage, jina, mixedbread)
      const data = (raw as { data?: Array<{ embedding?: number[] }> }).data;
      vector = data?.[0]?.embedding || [];
      tokens =
        (raw as { usage?: { total_tokens?: number; prompt_tokens?: number } })
          .usage?.total_tokens ??
          (raw as { usage?: { prompt_tokens?: number } }).usage
            ?.prompt_tokens ??
          0;
    }

    // Embeddings still bill by tokens
    const data = envelope({
      modality: "embedding",
      modelName: model,
      text: JSON.stringify(vector),
      units: tokens,
      unitType: "tokens",
      raw: { embedding: vector, dimensions: vector.length },
    });
    return { ok: true, status: 200, data };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      errorText: e instanceof Error ? e.message : "Embedding call failed",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  IMAGE GENERATION
// ─────────────────────────────────────────────────────────────────────────

const IMAGE_ENDPOINTS: Record<string, string> = {
  dall_e: "https://api.openai.com/v1/images/generations",
  stability: "https://api.stability.ai/v2beta/stable-image/generate/core",
  ideogram: "https://api.ideogram.ai/generate",
  black_forest_labs: "https://api.bfl.ml/v1/flux-pro-1.1",
  recraft: "https://external.api.recraft.ai/v1/images/generations",
  luma: "https://api.lumalabs.ai/dream-machine/v1/generations/image",
  runway: "https://api.dev.runwayml.com/v1/text_to_image",
  leonardo: "https://cloud.leonardo.ai/api/rest/v1/generations",
};

export async function callImage(
  provider: Provider,
  modelProfile: ModelProfile,
  fullMessages: Array<{ role: string; content: string }>,
  apiKey: string,
): Promise<ModalityResult> {
  const url = provider.base_url || IMAGE_ENDPOINTS[provider.type];
  if (!url) {
    return {
      ok: false,
      status: 501,
      errorText: `Image provider not wired: ${provider.type}`,
    };
  }
  const prompt = lastUserPrompt(fullMessages);
  const model = modelProfile.provider_model_name;

  try {
    let body: string;
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider.type === "dall_e") {
      body = JSON.stringify({ model, prompt, n: 1, size: "1024x1024" });
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (provider.type === "ideogram") {
      body = JSON.stringify({
        image_request: { prompt, model, aspect_ratio: "ASPECT_1_1" },
      });
      headers["Api-Key"] = apiKey;
    } else if (provider.type === "black_forest_labs") {
      body = JSON.stringify({ prompt, width: 1024, height: 1024 });
      headers["x-key"] = apiKey;
    } else if (provider.type === "leonardo") {
      body = JSON.stringify({
        prompt,
        modelId: model,
        num_images: 1,
        width: 1024,
        height: 1024,
      });
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (provider.type === "luma") {
      body = JSON.stringify({ prompt, model });
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else {
      // stability, recraft, runway — generic JSON + Bearer
      body = JSON.stringify({ prompt, model });
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorText: await response.text(),
      };
    }
    const raw = await response.json();

    // Best-effort extraction of an image URL/b64
    const r = raw as Record<string, unknown>;
    let imageRef = "";
    if (Array.isArray((r as { data?: unknown[] }).data)) {
      const first = (r as { data: Array<Record<string, unknown>> }).data[0] ||
        {};
      imageRef = String(first.url || first.b64_json || "");
    } else if (typeof (r as { image?: string }).image === "string") {
      imageRef = (r as { image: string }).image;
    } else if (Array.isArray((r as { images?: unknown[] }).images)) {
      const first =
        (r as { images: Array<Record<string, unknown> | string> }).images[0];
      imageRef = typeof first === "string"
        ? first
        : String((first as Record<string, unknown>)?.url || "");
    } else if (typeof (r as { id?: string }).id === "string") {
      imageRef = `pending:${(r as { id: string }).id}`;
    }

    const data = envelope({
      modality: "image",
      modelName: model,
      text: imageRef,
      units: 1,
      unitType: "images",
      raw,
    });
    return { ok: true, status: 200, data };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      errorText: e instanceof Error ? e.message : "Image call failed",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  VOICE — Text-to-Speech (TTS) and Speech-to-Text (STT)
// ─────────────────────────────────────────────────────────────────────────

const TTS_ENDPOINTS: Record<string, string> = {
  elevenlabs: "https://api.elevenlabs.io/v1/text-to-speech",
  cartesia: "https://api.cartesia.ai/tts/bytes",
  playht: "https://api.play.ht/api/v2/tts/stream",
  resemble: "https://app.resemble.ai/api/v2/projects",
  lmnt: "https://api.lmnt.com/v1/ai/speech",
  hume: "https://api.hume.ai/v0/tts",
  openai_tts: "https://api.openai.com/v1/audio/speech",
};

const STT_ENDPOINTS: Record<string, string> = {
  deepgram: "https://api.deepgram.com/v1/listen",
  assemblyai: "https://api.assemblyai.com/v2/transcript",
  rev_ai: "https://api.rev.ai/speechtotext/v1/jobs",
  speechmatics: "https://asr.api.speechmatics.com/v2/jobs/",
  openai_whisper: "https://api.openai.com/v1/audio/transcriptions",
};

export async function callVoiceTTS(
  provider: Provider,
  modelProfile: ModelProfile,
  fullMessages: Array<{ role: string; content: string }>,
  apiKey: string,
): Promise<ModalityResult> {
  const baseUrl = provider.base_url || TTS_ENDPOINTS[provider.type];
  if (!baseUrl) {
    return {
      ok: false,
      status: 501,
      errorText: `TTS provider not wired: ${provider.type}`,
    };
  }
  const text = lastUserPrompt(fullMessages);
  const model = modelProfile.provider_model_name;
  const voiceId = (modelProfile as { voice_id?: string }).voice_id || "default";

  try {
    let url = baseUrl;
    let body: string;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider.type === "elevenlabs") {
      url = `${baseUrl}/${voiceId}`;
      body = JSON.stringify({ text, model_id: model });
      headers["xi-api-key"] = apiKey;
    } else if (provider.type === "openai_tts") {
      body = JSON.stringify({ model, input: text, voice: voiceId });
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (provider.type === "cartesia") {
      body = JSON.stringify({
        model_id: model,
        transcript: text,
        voice: { mode: "id", id: voiceId },
      });
      headers["X-API-Key"] = apiKey;
      headers["Cartesia-Version"] = "2024-06-10";
    } else {
      // playht, resemble, lmnt, hume — generic JSON + Bearer
      body = JSON.stringify({ text, voice: voiceId, model });
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorText: await response.text(),
      };
    }

    // TTS responses are usually binary audio. We don't decode; we report bytes
    // and bill by character count (industry standard for TTS).
    const ab = await response.arrayBuffer();
    const audioRef = `audio:${ab.byteLength}bytes`;

    const data = envelope({
      modality: "voice_tts",
      modelName: model,
      text: audioRef,
      units: text.length,
      unitType: "characters",
      raw: {
        content_type: response.headers.get("content-type"),
        bytes: ab.byteLength,
      },
    });
    return { ok: true, status: 200, data };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      errorText: e instanceof Error ? e.message : "TTS call failed",
    };
  }
}

export async function callVoiceSTT(
  provider: Provider,
  modelProfile: ModelProfile,
  fullMessages: Array<{ role: string; content: string }>,
  apiKey: string,
): Promise<ModalityResult> {
  const url = provider.base_url || STT_ENDPOINTS[provider.type];
  if (!url) {
    return {
      ok: false,
      status: 501,
      errorText: `STT provider not wired: ${provider.type}`,
    };
  }
  // STT input is an audio URL passed as the user message text (or a base64 blob in metadata)
  const audioUrl = lastUserPrompt(fullMessages);
  const model = modelProfile.provider_model_name;

  try {
    let body: string;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider.type === "deepgram") {
      body = JSON.stringify({ url: audioUrl });
      headers["Authorization"] = `Token ${apiKey}`;
    } else if (provider.type === "assemblyai") {
      body = JSON.stringify({ audio_url: audioUrl, speech_model: model });
      headers["Authorization"] = apiKey;
    } else if (provider.type === "rev_ai") {
      body = JSON.stringify({ source_config: { url: audioUrl } });
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (provider.type === "openai_whisper") {
      // Whisper requires multipart/form-data with a file; we delegate that to
      // the caller by accepting an already-formed audio URL the SDK uploads.
      return {
        ok: false,
        status: 501,
        errorText:
          "openai_whisper requires multipart upload — use SDK helper to POST audio file directly",
      };
    } else {
      body = JSON.stringify({ audio_url: audioUrl });
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorText: await response.text(),
      };
    }
    const raw = await response.json() as Record<string, unknown>;

    // Best-effort transcript extraction
    const transcript = ((raw as {
      results?: {
        channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
      };
    })
      .results?.channels?.[0]?.alternatives?.[0]?.transcript) ||
      ((raw as { text?: string }).text) ||
      ((raw as { transcript?: string }).transcript) ||
      ((raw as { id?: string }).id
        ? `pending:${(raw as { id: string }).id}`
        : "");

    // Bill by audio_seconds when provider returns it; otherwise estimate from
    // transcript length / 15 chars per second. Better than nothing.
    const seconds =
      ((raw as { metadata?: { duration?: number } }).metadata?.duration) ||
      ((raw as { audio_duration?: number }).audio_duration) ||
      Math.ceil((transcript.length || 0) / 15);

    const data = envelope({
      modality: "voice_stt",
      modelName: model,
      text: String(transcript),
      units: seconds,
      unitType: "audio_seconds",
      raw,
    });
    return { ok: true, status: 200, data };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      errorText: e instanceof Error ? e.message : "STT call failed",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  SEARCH
// ─────────────────────────────────────────────────────────────────────────

const SEARCH_ENDPOINTS: Record<string, string> = {
  tavily: "https://api.tavily.com/search",
  exa: "https://api.exa.ai/search",
  serper: "https://google.serper.dev/search",
  brave_search: "https://api.search.brave.com/res/v1/web/search",
  you_com: "https://api.ydc-index.io/search",
  perplexity_sonar: "https://api.perplexity.ai/chat/completions",
  kagi: "https://kagi.com/api/v0/search",
  valyu: "https://api.valyu.network/v1/knowledge",
};

export async function callSearch(
  provider: Provider,
  modelProfile: ModelProfile,
  fullMessages: Array<{ role: string; content: string }>,
  apiKey: string,
): Promise<ModalityResult> {
  const baseUrl = provider.base_url || SEARCH_ENDPOINTS[provider.type];
  if (!baseUrl) {
    return {
      ok: false,
      status: 501,
      errorText: `Search provider not wired: ${provider.type}`,
    };
  }
  const query = lastUserPrompt(fullMessages);
  const model = modelProfile.provider_model_name;

  try {
    let url = baseUrl;
    let method = "POST";
    let body: string | undefined;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider.type === "tavily") {
      body = JSON.stringify({ api_key: apiKey, query, max_results: 10 });
    } else if (provider.type === "exa") {
      body = JSON.stringify({ query, numResults: 10 });
      headers["x-api-key"] = apiKey;
    } else if (provider.type === "serper") {
      body = JSON.stringify({ q: query });
      headers["X-API-KEY"] = apiKey;
    } else if (provider.type === "brave_search") {
      method = "GET";
      url = `${baseUrl}?q=${encodeURIComponent(query)}`;
      headers["X-Subscription-Token"] = apiKey;
      headers["Accept"] = "application/json";
    } else if (provider.type === "you_com") {
      method = "GET";
      url = `${baseUrl}?query=${encodeURIComponent(query)}`;
      headers["X-API-Key"] = apiKey;
    } else if (provider.type === "perplexity_sonar") {
      body = JSON.stringify({
        model: model || "sonar",
        messages: [{ role: "user", content: query }],
      });
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (provider.type === "kagi") {
      method = "GET";
      url = `${baseUrl}?q=${encodeURIComponent(query)}`;
      headers["Authorization"] = `Bot ${apiKey}`;
    } else if (provider.type === "valyu") {
      body = JSON.stringify({ query, search_type: "all" });
      headers["x-api-key"] = apiKey;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : body,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorText: await response.text(),
      };
    }
    const raw = await response.json() as Record<string, unknown>;

    // Flatten results to a simple "title — url\nsnippet" markdown
    const results: Array<
      { title?: string; url?: string; snippet?: string; content?: string }
    > = ((raw as { results?: Array<Record<string, unknown>> }).results as Array<
      { title?: string; url?: string; snippet?: string; content?: string }
    >) ||
      ((raw as { web?: { results?: Array<Record<string, unknown>> } }).web
        ?.results as Array<
          { title?: string; url?: string; snippet?: string; content?: string }
        >) ||
      ((raw as { hits?: Array<Record<string, unknown>> }).hits as Array<
        { title?: string; url?: string; snippet?: string; content?: string }
      >) ||
      ((raw as { data?: Array<Record<string, unknown>> }).data as Array<
        { title?: string; url?: string; snippet?: string; content?: string }
      >) ||
      [];

    const text = results
      .slice(0, 10)
      .map((r) =>
        `**${r.title || "(untitled)"}** — ${r.url || ""}\n${
          r.snippet || r.content || ""
        }`
      )
      .join("\n\n");

    const data = envelope({
      modality: "search",
      modelName: model,
      text: text || JSON.stringify(raw).slice(0, 2000),
      units: 1,
      unitType: "searches",
      raw,
    });
    return { ok: true, status: 200, data };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      errorText: e instanceof Error ? e.message : "Search call failed",
    };
  }
}
