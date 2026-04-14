# frozen_string_literal: true

module StackSpine
  # Token usage information.
  Usage = Struct.new(:input_tokens, :output_tokens, :total_tokens, keyword_init: true) do
    def initialize(input_tokens: 0, output_tokens: 0, total_tokens: 0)
      super
    end
  end

  # Response from POST /v1/tasks/{task}/run.
  RunResponse = Struct.new(
    :id, :task, :status, :model, :provider, :content, :output,
    :usage, :cost_usd, :latency_ms, :was_canary, :route_strategy, :raw,
    keyword_init: true
  ) do
    def initialize(id: "", task: "", status: "succeeded", model: nil, provider: nil,
                   content: nil, output: nil, usage: nil, cost_usd: nil,
                   latency_ms: nil, was_canary: nil, route_strategy: nil, raw: nil)
      super
    end
  end

  # A single SSE event from StackSpine.
  StreamEvent = Struct.new(:type, :data, :id, :event, keyword_init: true) do
    def initialize(type: "message", data: {}, id: nil, event: nil)
      super
    end
  end
end
