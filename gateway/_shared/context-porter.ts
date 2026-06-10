/**
 * @fileoverview Cross-model context portability — token estimation,
 * conversation compression, and format normalization.
 * @module invoke/_shared/context-porter
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

interface ModelProfileSlim {
  id: string;
  context_window_tokens: number | null;
  provider_model_name: string;
}

interface Message {
  role: string;
  content: string;
}

interface PortResult {
  messages: Message[];
  compressed: boolean;
  originalTokens: number;
  compressedTokens: number;
}

/** Estimate token count using chars/4 heuristic */
function estimateTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

/**
 * Port conversation context to fit the target model's context window.
 *
 * Strategy:
 * 1. If estimated tokens < 80% of context window → pass through.
 * 2. Check cache for an existing summary for this session.
 * 3. If no cache hit, summarize older messages via Lovable AI (fast model).
 * 4. If summarization fails, truncate (keep last N that fit).
 */
export async function portContext(
  fullMessages: Message[],
  modelProfile: ModelProfileSlim,
  sessionId: string | null,
  orgId: string,
  supabase: SupabaseClient,
  lovableApiKey: string | undefined,
): Promise<PortResult> {
  const contextWindow = modelProfile.context_window_tokens || 128000;
  const threshold = Math.floor(contextWindow * 0.8); // 80% — leave headroom for output
  const originalTokens = estimateTokens(fullMessages);

  // Under threshold → pass through unchanged
  if (originalTokens <= threshold) {
    return {
      messages: fullMessages,
      compressed: false,
      originalTokens,
      compressedTokens: originalTokens,
    };
  }

  // Separate system prompt from conversation
  const systemMessages = fullMessages.filter((m) => m.role === "system");
  const conversationMessages = fullMessages.filter((m) => m.role !== "system");

  // Always preserve at least the last 4 conversation messages
  const preserveCount = Math.max(4, Math.min(conversationMessages.length, 4));
  const recentMessages = conversationMessages.slice(-preserveCount);
  const olderMessages = conversationMessages.slice(0, -preserveCount);

  // If no older messages to compress, just truncate to fit
  if (olderMessages.length === 0) {
    return truncateToFit(fullMessages, threshold, originalTokens);
  }

  // Check cache for existing summary
  if (sessionId) {
    const { data: cached } = await supabase
      .from("context_summaries")
      .select("summary, compressed_token_count")
      .eq("org_id", orgId)
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (cached?.summary) {
      const summaryMessage: Message = {
        role: "assistant",
        content:
          `[Context summary of previous conversation]: ${cached.summary}`,
      };
      const ported = [...systemMessages, summaryMessage, ...recentMessages];
      const compressedTokens = estimateTokens(ported);

      if (compressedTokens <= threshold) {
        return {
          messages: ported,
          compressed: true,
          originalTokens,
          compressedTokens,
        };
      }
      // Cached summary still too large — fall through to re-summarize or truncate
    }
  }

  // Attempt summarization via Lovable AI (fast model)
  if (lovableApiKey) {
    try {
      const summary = await summarizeMessages(olderMessages, lovableApiKey);
      if (summary) {
        const summaryMessage: Message = {
          role: "assistant",
          content: `[Context summary of previous conversation]: ${summary}`,
        };
        const ported = [...systemMessages, summaryMessage, ...recentMessages];
        const compressedTokens = estimateTokens(ported);

        // Cache the summary
        if (sessionId) {
          supabase
            .from("context_summaries")
            .insert({
              org_id: orgId,
              session_id: sessionId,
              summary,
              original_token_count: originalTokens,
              compressed_token_count: compressedTokens,
              model_used: "google/gemini-2.5-flash-lite",
            })
            .then(() => {}); // fire-and-forget
        }

        return {
          messages: ported,
          compressed: true,
          originalTokens,
          compressedTokens,
        };
      }
    } catch (e) {
      console.error(
        "Context summarization failed, falling back to truncation:",
        e,
      );
    }
  }

  // Fallback: truncate to fit
  return truncateToFit(fullMessages, threshold, originalTokens);
}

/** Truncate messages from the front (oldest) until they fit within the token limit */
function truncateToFit(
  messages: Message[],
  maxTokens: number,
  originalTokens: number,
): PortResult {
  const systemMessages = messages.filter((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");

  // Always keep at least last 4 conversation messages
  const minKeep = Math.min(4, conversation.length);
  let kept = conversation.slice(-minKeep);
  let currentTokens = estimateTokens([...systemMessages, ...kept]);

  // Add more messages from the end while under budget
  for (let i = conversation.length - minKeep - 1; i >= 0; i--) {
    const msgTokens = Math.ceil(conversation[i].content.length / 4);
    if (currentTokens + msgTokens > maxTokens) break;
    kept = [conversation[i], ...kept];
    currentTokens += msgTokens;
  }

  const result = [...systemMessages, ...kept];
  return {
    messages: result,
    compressed: true,
    originalTokens,
    compressedTokens: estimateTokens(result),
  };
}

/** Call Lovable AI to summarize older messages into a concise context block */
async function summarizeMessages(
  messages: Message[],
  apiKey: string,
): Promise<string | null> {
  const conversationText = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");

  // Cap input to summarizer to avoid excessive cost
  const truncatedText = conversationText.length > 50000
    ? conversationText.slice(-50000)
    : conversationText;

  const response = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content:
              "You are a conversation summarizer. Produce a concise summary of the following conversation history. Preserve key facts, decisions, user preferences, and any context that would be needed to continue the conversation naturally. Be factual and thorough but brief. Output only the summary, no preamble.",
          },
          {
            role: "user",
            content: `Summarize this conversation history:\n\n${truncatedText}`,
          },
        ],
        max_tokens: 2048,
        temperature: 0.3,
      }),
    },
  );

  if (!response.ok) {
    console.error(
      "Summarization API error:",
      response.status,
      await response.text(),
    );
    return null;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  return content || null;
}
