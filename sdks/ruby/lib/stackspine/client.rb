# frozen_string_literal: true

require "net/http"
require "uri"
require "json"

module StackSpine
  DEFAULT_BASE_URL   = "https://api.stackspine.ai"
  DEFAULT_TIMEOUT    = 60
  DEFAULT_MAX_RETRIES = 3

  class Client
    # @param api_key    [String]  StackSpine API key (required)
    # @param base_url   [String]  API base URL
    # @param timeout    [Numeric] Request timeout in seconds
    # @param max_retries [Integer] Max automatic retries on 429/5xx
    def initialize(api_key:, base_url: DEFAULT_BASE_URL, timeout: DEFAULT_TIMEOUT, max_retries: DEFAULT_MAX_RETRIES)
      raise ValidationError, "api_key is required" if api_key.nil? || api_key.empty?

      @api_key     = api_key
      @base_url    = base_url.chomp("/")
      @timeout     = timeout
      @max_retries = max_retries
    end

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    # GET /v1/health
    # @return [Hash]
    def health
      data, = _request("GET", "/v1/health")
      data
    end

    # POST /v1/tasks/{task}/run
    # @param task     [String] Task key
    # @param input    [Hash]   Input payload
    # @param metadata [Hash, nil] Optional metadata
    # @return [RunResponse]
    def run(task, input, metadata: nil)
      payload = { input: input }
      payload[:metadata] = metadata if metadata

      data, = _request("POST", "/v1/tasks/#{task}/run", json: payload)
      _parse_run_response(data, task)
    end

    # POST /v1/tasks/{task}/stream — yields StreamEvent
    # @param task     [String] Task key
    # @param input    [Hash]   Input payload
    # @param metadata [Hash, nil] Optional metadata
    # @yieldparam event [StreamEvent]
    def stream(task, input, metadata: nil, &block)
      raise ValidationError, "stream requires a block" unless block_given?

      payload = { input: input }
      payload[:metadata] = metadata if metadata

      _stream_request("/v1/tasks/#{task}/stream", payload, &block)
    end

    private

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    def _build_uri(path)
      URI.parse("#{@base_url}#{path}")
    end

    def _auth_headers
      { "Authorization" => "Bearer #{@api_key}", "Content-Type" => "application/json" }
    end

    # Non-streaming request with retries.
    def _request(method, path, json: nil, attempt: 0)
      uri = _build_uri(path)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = @timeout
      http.read_timeout = @timeout

      req = case method.upcase
            when "GET"  then Net::HTTP::Get.new(uri)
            when "POST" then Net::HTTP::Post.new(uri)
            else raise ValidationError, "Unsupported HTTP method: #{method}"
            end

      _auth_headers.each { |k, v| req[k] = v }
      req["Accept"] = "application/json"
      req.body = JSON.generate(json) if json

      resp = begin
        http.request(req)
      rescue Net::OpenTimeout, Net::ReadTimeout => e
        raise TimeoutError.new(@timeout)
      rescue IOError, SocketError, Errno::ECONNREFUSED, Errno::ECONNRESET => e
        if attempt < @max_retries
          sleep(_backoff_delay(attempt))
          return _request(method, path, json: json, attempt: attempt + 1)
        end
        raise Error, "Connection failed: #{e.message}"
      end

      request_id = resp["x-request-id"]
      status = resp.code.to_i

      body = begin
        JSON.parse(resp.body || "{}")
      rescue JSON::ParserError
        { "raw" => resp.body }
      end

      # Retry on retryable status codes
      if (status >= 500 || status == 429) && attempt < @max_retries
        delay = _backoff_delay(attempt)
        if status == 429
          delay = (resp["Retry-After"] || delay).to_f
        end
        sleep(delay)
        return _request(method, path, json: json, attempt: attempt + 1)
      end

      _raise_for_error(status, body, request_id)
      [body, request_id]
    end

    # Streaming request — opens chunked connection and parses SSE.
    def _stream_request(path, payload, &block)
      uri = _build_uri(path)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = @timeout
      http.read_timeout = @timeout

      req = Net::HTTP::Post.new(uri)
      _auth_headers.each { |k, v| req[k] = v }
      req["Accept"] = "text/event-stream"
      req.body = JSON.generate(payload)

      http.request(req) do |resp|
        status = resp.code.to_i

        if status >= 300
          body_str = resp.read_body
          body = begin
            JSON.parse(body_str)
          rescue JSON::ParserError
            { "raw" => body_str }
          end
          _raise_for_error(status, body, resp["x-request-id"])
        end

        chunk_enum = Enumerator.new do |y|
          resp.read_body { |chunk| y << chunk }
        end

        Streaming.each_sse_event(chunk_enum, &block)
      end
    end

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _backoff_delay(attempt, base: 1.0)
      delay = base * (2**attempt)
      jitter = rand
      [delay + jitter, 30.0].min
    end

    def _raise_for_error(status, body, request_id)
      return if status >= 200 && status < 300

      message = if body.is_a?(Hash)
                  body["message"] || body["error"] || body.to_json
                else
                  body.to_s
                end
      details = body.is_a?(Hash) ? body["details"] : nil

      case status
      when 429
        retry_after = body.is_a?(Hash) ? (body["retry_after"] || 60).to_f : 60.0
        raise RateLimitError.new(message, retry_after: retry_after, request_id: request_id)
      when 402
        d = details || {}
        raise BudgetExceededError.new(
          message,
          limit_usd: (d["limit_usd"] || 0).to_f,
          current_spend_usd: (d["current_spend_usd"] || 0).to_f,
          request_id: request_id
        )
      when 503
        raise AllProvidersFailedError.new(message, request_id: request_id)
      else
        raise APIError.new(message, status_code: status, request_id: request_id, details: details)
      end
    end

    def _parse_run_response(data, task)
      usage = nil
      if data["usage"].is_a?(Hash)
        u = data["usage"]
        usage = Usage.new(
          input_tokens:  u["input_tokens"] || u["prompt_tokens"] || 0,
          output_tokens: u["output_tokens"] || u["completion_tokens"] || 0,
          total_tokens:  u["total_tokens"] || 0
        )
      end

      RunResponse.new(
        id:             (data["id"] || data["run_id"] || "").to_s,
        task:           task,
        status:         data["status"] || "succeeded",
        model:          data["model"],
        provider:       data["provider"],
        content:        data["content"],
        output:         data["output"],
        usage:          usage,
        cost_usd:       data["cost_usd"],
        latency_ms:     data["latency_ms"],
        was_canary:     data["was_canary"],
        route_strategy: data["route_strategy"],
        raw:            data
      )
    end
  end
end
