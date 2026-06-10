/**
 * StackSpine SDK Error Classes
 * Custom error types for handling API responses
 */

import type { ErrorCode, APIErrorResponse } from './types';

/** Base error class for StackSpine SDK */
export class StackSpineError extends Error {
  /** Error code from the API */
  public readonly code: ErrorCode;
  /** HTTP status code */
  public readonly status: number;
  /** Additional error details */
  public readonly details?: Record<string, unknown>;
  /** Original response (if available) */
  public readonly response?: Response;

  constructor(
    message: string,
    code: ErrorCode,
    status: number,
    details?: Record<string, unknown>,
    response?: Response
  ) {
    super(message);
    this.name = 'StackSpineError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.response = response;

    // Maintains proper stack trace for where error was thrown (V8-only API)
    const E = Error as unknown as {
      captureStackTrace?: (target: object, constructor: Function) => void;
    };
    if (typeof E.captureStackTrace === "function") {
      E.captureStackTrace(this, StackSpineError);
    }
  }

  /** Check if error is retryable */
  get isRetryable(): boolean {
    return (
      this.code === 'rate_limited' ||
      this.code === 'all_providers_failed' ||
      this.status >= 500
    );
  }

  /** Create from API response */
  static async fromResponse(response: Response): Promise<StackSpineError> {
    let errorData: APIErrorResponse;
    
    try {
      errorData = await response.json();
    } catch {
      return new StackSpineError(
        `HTTP ${response.status}: ${response.statusText}`,
        'internal_error',
        response.status,
        undefined,
        response
      );
    }

    return new StackSpineError(
      errorData.error.message,
      errorData.error.code,
      response.status,
      errorData.error.details,
      response
    );
  }
}

/** Error thrown when authentication fails */
export class AuthenticationError extends StackSpineError {
  constructor(message: string = 'Invalid or missing API key') {
    super(message, 'unauthorized', 401);
    this.name = 'AuthenticationError';
  }
}

/** Error thrown when rate limit is exceeded */
export class RateLimitError extends StackSpineError {
  /** Seconds until rate limit resets */
  public readonly retryAfter: number;

  constructor(message: string, retryAfter: number = 60) {
    super(message, 'rate_limited', 429, { retry_after: retryAfter });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/** Error thrown when budget limit is exceeded */
export class BudgetExceededError extends StackSpineError {
  /** Monthly budget limit in USD */
  public readonly limitUsd: number;
  /** Current spend in USD */
  public readonly currentSpendUsd: number;

  constructor(
    message: string,
    limitUsd: number,
    currentSpendUsd: number
  ) {
    super(message, 'budget_exceeded', 402, {
      limit_usd: limitUsd,
      current_spend_usd: currentSpendUsd,
    });
    this.name = 'BudgetExceededError';
    this.limitUsd = limitUsd;
    this.currentSpendUsd = currentSpendUsd;
  }
}

/** Error thrown when all providers fail */
export class AllProvidersFailedError extends StackSpineError {
  constructor(message: string = 'All configured providers are unavailable') {
    super(message, 'all_providers_failed', 503);
    this.name = 'AllProvidersFailedError';
  }
}

/** Error thrown when request times out */
export class TimeoutError extends StackSpineError {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`, 'internal_error', 408);
    this.name = 'TimeoutError';
  }
}

/** Error thrown for client-side validation failures (request never sent) */
export class ValidationError extends StackSpineError {
  constructor(message: string) {
    super(message, 'invalid_request', 0);
    this.name = 'ValidationError';
  }
}

/** Error thrown when SSE stream parsing fails */
export class StreamError extends StackSpineError {
  constructor(message: string) {
    super(message, 'internal_error', 0);
    this.name = 'StreamError';
  }
}
