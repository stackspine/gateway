/**
 * StackSpine SDK Types
 * Type definitions for the StackSpine API client
 */

/** Message role in a conversation */
export type MessageRole = 'system' | 'user' | 'assistant';

/** A single message in a conversation */
export interface Message {
  role: MessageRole;
  content: string;
}

/** Request payload for the invoke endpoint */
export interface InvokeRequest {
  /** Task key identifier */
  task: string;
  /** Conversation messages */
  messages: Message[];
  /** Maximum tokens in response */
  max_tokens?: number;
  /** Sampling temperature (0-2) */
  temperature?: number;
  /** Enable streaming response */
  stream?: boolean;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/** Token usage information */
export interface Usage {
  /** Tokens in the input/prompt */
  input_tokens: number;
  /** Tokens in the output/completion */
  output_tokens: number;
  /** Total tokens used */
  total_tokens: number;
}

/** Route strategy used for the request */
export type RouteStrategy = 'primary' | 'fallback' | 'canary';

/** Response from the invoke endpoint */
export interface InvokeResponse {
  /** Unique call log ID */
  id: string;
  /** Task key that was invoked */
  task: string;
  /** Model that processed the request */
  model: string;
  /** Provider that handled the request */
  provider: string;
  /** Generated response content */
  content: string;
  /** Token usage information */
  usage: Usage;
  /** Cost in USD */
  cost_usd: number;
  /** Request latency in milliseconds */
  latency_ms: number;
  /** Whether this request used a canary route */
  was_canary: boolean;
  /** Routing strategy used */
  route_strategy: RouteStrategy;
}

/** Streaming chunk from SSE response */
export interface StreamChunk {
  /** Chunk content */
  content: string;
  /** Whether this is the final chunk */
  done: boolean;
  /** Final usage info (only on last chunk) */
  usage?: Usage;
}

/** Usage metrics for a time period */
export interface UsageMetrics {
  /** Start date of the period */
  start_date: string;
  /** End date of the period */
  end_date: string;
  /** Total number of requests */
  total_requests: number;
  /** Total cost in USD */
  total_cost_usd: number;
  /** Total tokens used */
  total_tokens: number;
  /** Grouped usage data */
  by_group: UsageGroup[];
}

/** Usage grouped by a dimension */
export interface UsageGroup {
  /** Group key (task key, provider name, etc.) */
  key: string;
  /** Number of requests */
  requests: number;
  /** Cost in USD */
  cost_usd: number;
  /** Total tokens */
  tokens: number;
  /** Average latency in milliseconds */
  avg_latency_ms: number;
}

/** Grouping dimension for usage queries */
export type UsageGroupBy = 'task' | 'provider' | 'model' | 'day';

/** Parameters for usage query */
export interface UsageParams {
  /** Start date (YYYY-MM-DD) */
  start_date: string;
  /** End date (YYYY-MM-DD) */
  end_date: string;
  /** Group results by dimension */
  group_by?: UsageGroupBy;
}

/** SDK configuration options */
export interface StackSpineConfig {
  /** Your StackSpine API key */
  apiKey: string;
  /** Base URL for the API (optional, for self-hosted) */
  baseUrl?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Custom fetch implementation */
  fetch?: typeof fetch;
}

/** Error codes returned by the API */
export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'all_providers_failed'
  | 'internal_error';

/** Error response from the API */
export interface APIErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}
