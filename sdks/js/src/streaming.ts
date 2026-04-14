/**
 * StackSpine SDK Streaming Utilities
 * Helpers for handling Server-Sent Events (SSE) responses
 */

import type { StreamChunk, Usage } from './types';

/** Parse a single SSE line into content */
function parseSSELine(line: string): string | null {
  if (line.startsWith('data: ')) {
    const data = line.slice(6);
    if (data === '[DONE]') {
      return null;
    }
    try {
      const parsed = JSON.parse(data);
      // Handle different streaming formats
      if (parsed.choices?.[0]?.delta?.content) {
        return parsed.choices[0].delta.content;
      }
      if (parsed.content) {
        return parsed.content;
      }
      if (typeof parsed === 'string') {
        return parsed;
      }
    } catch {
      // If not JSON, treat as raw text
      return data;
    }
  }
  return null;
}

/** Parse usage from final SSE message */
function parseUsage(line: string): Usage | undefined {
  if (line.startsWith('data: ')) {
    const data = line.slice(6);
    try {
      const parsed = JSON.parse(data);
      if (parsed.usage) {
        return {
          input_tokens: parsed.usage.prompt_tokens || parsed.usage.input_tokens || 0,
          output_tokens: parsed.usage.completion_tokens || parsed.usage.output_tokens || 0,
          total_tokens: parsed.usage.total_tokens || 0,
        };
      }
    } catch {
      // Ignore parse errors
    }
  }
  return undefined;
}

/**
 * Create an async iterator from an SSE response stream
 * 
 * @example
 * ```typescript
 * const response = await fetch(url, { ... });
 * for await (const chunk of streamResponse(response)) {
 *   process.stdout.write(chunk.content);
 * }
 * ```
 */
export async function* streamResponse(
  response: Response
): AsyncGenerator<StreamChunk, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response body is not readable');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let lastUsage: Usage | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        // Process any remaining buffer
        if (buffer.trim()) {
          const content = parseSSELine(buffer);
          if (content) {
            yield { content, done: false };
          }
        }
        yield { content: '', done: true, usage: lastUsage };
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      
      // Keep the last incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check for usage in the line
        const usage = parseUsage(trimmed);
        if (usage) {
          lastUsage = usage;
        }

        const content = parseSSELine(trimmed);
        if (content !== null) {
          yield { content, done: false };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Collect all chunks from a stream into a single string
 * 
 * @example
 * ```typescript
 * const { text, usage } = await collectStream(streamResponse(response));
 * console.log(text);
 * ```
 */
export async function collectStream(
  stream: AsyncIterable<StreamChunk>
): Promise<{ text: string; usage?: Usage }> {
  let text = '';
  let usage: Usage | undefined;

  for await (const chunk of stream) {
    text += chunk.content;
    if (chunk.usage) {
      usage = chunk.usage;
    }
  }

  return { text, usage };
}
