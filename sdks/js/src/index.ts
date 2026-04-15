/**
 * StackSpine SDK
 * Official TypeScript/JavaScript client for the StackSpine API
 * 
 * @example
 * ```typescript
 * import { StackSpine } from '@stackspine/sdk';
 * 
 * const client = new StackSpine({ apiKey: 'ss_live_xxx' });
 * 
 * // Simple invocation
 * const response = await client.invoke('chat-support', [
 *   { role: 'user', content: 'Hello!' }
 * ]);
 * console.log(response.content);
 * 
 * // Streaming
 * for await (const chunk of client.stream('chat-support', messages)) {
 *   process.stdout.write(chunk.content);
 * }
 * ```
 */

import type {
  StackSpineConfig,
  Message,
  InvokeRequest,
  InvokeResponse,
  StreamChunk,
  UsageMetrics,
  UsageParams,
} from './types';

import {
  StackSpineError,
  AuthenticationError,
  RateLimitError,
  BudgetExceededError,
  AllProvidersFailedError,
  TimeoutError,
  ValidationError,
  StreamError,
} from './errors';

import { streamResponse, collectStream } from './streaming';

// Re-export types and errors
export * from './types';
export * from './errors';
export { streamResponse, collectStream } from './streaming';

/** Default configuration values */
const DEFAULT_CONFIG = {
  baseUrl: 'https://api.stackspine.com',
  timeout: 30000,
  maxRetries: 3,
} as const;

/** Calculate exponential backoff delay */
function getBackoffDelay(attempt: number, baseDelay = 1000): number {
  // Exponential backoff with jitter: 1s, 2s, 4s, etc. + random jitter
  const delay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return Math.min(delay + jitter, 30000); // Cap at 30 seconds
}

/** Sleep for a specified duration */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * StackSpine API Client
 * 
 * Provides type-safe access to the StackSpine API with automatic retries,
 * streaming support, and comprehensive error handling.
 */
export class StackSpine {
  private readonly config: Required<Pick<StackSpineConfig, 'apiKey' | 'baseUrl' | 'timeout' | 'maxRetries'>>;
  private readonly fetchFn: typeof fetch;

  constructor(config: StackSpineConfig) {
    if (!config.apiKey) {
      throw new AuthenticationError('API key is required');
    }

    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || DEFAULT_CONFIG.baseUrl,
      timeout: config.timeout || DEFAULT_CONFIG.timeout,
      maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
    };

    this.fetchFn = config.fetch || globalThis.fetch;
  }

  /**
   * Make an authenticated request to the API
   */
  private async request<T>(
    path: string,
    options: RequestInit = {},
    retryCount = 0
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await this.fetchFn(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'x-api-version': '1',
          ...options.headers,
        },
      });

      if (!response.ok) {
        const error = await StackSpineError.fromResponse(response);
        
        // Handle specific error types
        if (response.status === 401) {
          throw new AuthenticationError(error.message);
        }
        
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
          throw new RateLimitError(error.message, retryAfter);
        }
        
        // [Patent 1, Claim 1(f)] — Structured 402 BUDGET_EXCEEDED response.
        // See "Pre-Request Budget Enforcement in a Multi-Model AI Routing System."
        if (response.status === 402) {
          const details = error.details || {};
          throw new BudgetExceededError(
            error.message,
            details.limit_usd as number || 0,
            details.current_spend_usd as number || 0
          );
        }
        
        if (response.status === 503 && error.code === 'all_providers_failed') {
          throw new AllProvidersFailedError(error.message);
        }

        // Retry on retryable errors
        if (error.isRetryable && retryCount < this.config.maxRetries) {
          const delay = error.code === 'rate_limited'
            ? (error.details?.retry_after as number || 60) * 1000
            : getBackoffDelay(retryCount);
          
          await sleep(delay);
          return this.request<T>(path, options, retryCount + 1);
        }

        throw error;
      }

      return response.json();
    } catch (error) {
      if (error instanceof StackSpineError) {
        throw error;
      }
      
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new TimeoutError(this.config.timeout);
      }

      // Network errors - retry if allowed
      if (retryCount < this.config.maxRetries) {
        await sleep(getBackoffDelay(retryCount));
        return this.request<T>(path, options, retryCount + 1);
      }

      throw new StackSpineError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'internal_error',
        0
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a streaming request to the API
   */
  private async requestStream(
    path: string,
    body: unknown
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'x-api-version': '1',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await StackSpineError.fromResponse(response);
      throw error;
    }

    return response;
  }

  /**
   * Invoke an AI task
   * 
   * @param task - Task key identifier
   * @param messages - Conversation messages
   * @param options - Additional options (max_tokens, temperature, etc.)
   * @returns The inference response
   * 
   * @example
   * ```typescript
   * const response = await client.invoke('chat-support', [
   *   { role: 'system', content: 'You are a helpful assistant.' },
   *   { role: 'user', content: 'Hello!' }
   * ]);
   * console.log(response.content);
   * ```
   */
  async invoke(
    task: string,
    messages: Message[],
    options: Partial<Omit<InvokeRequest, 'task' | 'messages' | 'stream'>> = {}
  ): Promise<InvokeResponse> {
    const body: InvokeRequest = {
      task,
      messages,
      stream: false,
      ...options,
    };

    return this.request<InvokeResponse>('/functions/v1/invoke', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Run a task (standard API, matches Go/Python/Ruby SDKs)
   * 
   * @param task - Task key identifier
   * @param input - Input data for the task
   * @param metadata - Optional metadata
   * @returns The run response
   * 
   * @example
   * ```typescript
   * const response = await client.run('summarize', { text: 'Hello world' });
   * console.log(response.content);
   * console.log(response.usage);
   * ```
   */
  async run(
    task: string,
    input: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): Promise<InvokeResponse> {
    const body: Record<string, unknown> = { input };
    if (metadata) {
      body.metadata = metadata;
    }

    return this.request<InvokeResponse>(`/v1/tasks/${encodeURIComponent(task)}/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Invoke an AI task with streaming response (legacy, message-based)
   * 
   * @param task - Task key identifier
   * @param messages - Conversation messages
   * @param options - Additional options (max_tokens, temperature, etc.)
   * @returns Async iterator of response chunks
   */
  async *streamMessages(
    task: string,
    messages: Message[],
    options: Partial<Omit<InvokeRequest, 'task' | 'messages' | 'stream'>> = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const body: InvokeRequest = {
      task,
      messages,
      stream: true,
      ...options,
    };

    const response = await this.requestStream('/functions/v1/invoke', body);
    yield* streamResponse(response);
  }

  /**
   * Stream a task (standard API, matches Go/Python/Ruby SDKs)
   * 
   * @param task - Task key identifier
   * @param input - Input data for the task
   * @param metadata - Optional metadata
   * @returns Async iterator of response chunks
   * 
   * @example
   * ```typescript
   * for await (const chunk of client.stream('chat', { messages: [...] })) {
   *   process.stdout.write(chunk.content);
   * }
   * ```
   */
  async *stream(
    task: string,
    input: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const body: Record<string, unknown> = { input };
    if (metadata) {
      body.metadata = metadata;
    }

    const response = await this.requestStream(`/v1/tasks/${encodeURIComponent(task)}/stream`, body);
    yield* streamResponse(response);
  }

  /**
   * Get usage metrics for a time period
   * 
   * @param params - Query parameters (start_date, end_date, group_by)
   * @returns Aggregated usage metrics
   */
  async getUsage(params: UsageParams): Promise<UsageMetrics> {
    const searchParams = new URLSearchParams({
      start_date: params.start_date,
      end_date: params.end_date,
      ...(params.group_by && { group_by: params.group_by }),
    });

    return this.request<UsageMetrics>(`/v1/usage?${searchParams}`, {
      method: 'GET',
    });
  }
}

// Default export for convenience
export default StackSpine;
