# frozen_string_literal: true

module StackSpine
  # Base error for all SDK errors.
  class Error < StandardError; end

  # Generic API error with status code, request ID, and retryability.
  class APIError < Error
    attr_reader :status_code, :request_id, :details

    def initialize(message, status_code:, request_id: nil, details: nil)
      super(message)
      @status_code = status_code
      @request_id  = request_id
      @details     = details
    end

    def retryable?
      status_code == 429 || status_code == 503 || status_code >= 500
    end
  end

  # 429 Too Many Requests.
  class RateLimitError < APIError
    attr_reader :retry_after

    def initialize(message = "Rate limit exceeded", retry_after: 60.0, request_id: nil)
      super(message, status_code: 429, request_id: request_id)
      @retry_after = retry_after.to_f
    end
  end

  # 402 Budget exhausted.
  class BudgetExceededError < APIError
    attr_reader :limit_usd, :current_spend_usd

    def initialize(message = "Budget exceeded", limit_usd: 0.0, current_spend_usd: 0.0, request_id: nil)
      super(message, status_code: 402, request_id: request_id,
            details: { "limit_usd" => limit_usd, "current_spend_usd" => current_spend_usd })
      @limit_usd         = limit_usd.to_f
      @current_spend_usd = current_spend_usd.to_f
    end
  end

  # 503 All providers unavailable.
  class AllProvidersFailedError < APIError
    def initialize(message = "All configured providers are unavailable", request_id: nil)
      super(message, status_code: 503, request_id: request_id)
    end
  end

  # Client-side timeout.
  class TimeoutError < Error
    attr_reader :timeout_seconds

    def initialize(timeout_seconds)
      super("Request timed out after #{timeout_seconds}s")
      @timeout_seconds = timeout_seconds.to_f
    end
  end

  # Client-side validation error (never sent to server).
  class ValidationError < Error; end

  # Error during SSE stream parsing.
  class StreamError < Error; end
end
