# StackSpine Ruby SDK (`sdk-ruby`)

Official Ruby client for **StackSpine** (Multi‑Model AI Control Plane).

## Install

```bash
gem install stackspine
```

Or add to your Gemfile:

```ruby
gem "stackspine", "~> 1.0"
```

## Quickstart

```ruby
require "stackspine"

client = StackSpine::Client.new(api_key: ENV["STACKSPINE_API_KEY"])

response = client.run("summarize", { text: "Hello from StackSpine!" })
puts response.content
```

## Streaming (SSE)

```ruby
client.stream("chat", { messages: [{ role: "user", content: "Hi" }] }) do |event|
  print event.data["content"] if event.type == "message"
end
```

## Error Handling

```ruby
begin
  response = client.run("summarize", { text: "Hello!" })
rescue StackSpine::RateLimitError => e
  puts "Rate limited. Retry after #{e.retry_after}s"
rescue StackSpine::BudgetExceededError => e
  puts "Budget exceeded: $#{e.current_spend_usd}/$#{e.limit_usd}"
rescue StackSpine::AllProvidersFailedError
  puts "All providers are down"
rescue StackSpine::APIError => e
  puts "API error (#{e.status_code}): #{e.message}"
end
```

## Retry Behavior

The SDK automatically retries on:
- Network errors
- 5xx server errors
- 503 (all providers failed)
- 429 (rate limited) — waits for Retry-After header

Retries use exponential backoff with jitter, capped at 30 seconds.

```ruby
client = StackSpine::Client.new(
  api_key: ENV["STACKSPINE_API_KEY"],
  max_retries: 5,
  timeout: 90
)
```

## Response Fields

`RunResponse` includes full observability data:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `String` | Run ID |
| `task` | `String` | Task key |
| `status` | `String` | `succeeded`, `failed`, etc. |
| `model` | `String` | Model used (e.g., `gpt-4-turbo`) |
| `provider` | `String` | Provider (e.g., `openai`) |
| `content` | `String` | Generated text |
| `cost_usd` | `Float` | Cost in USD |
| `latency_ms` | `Float` | Latency in ms |
| `was_canary` | `Boolean` | Whether canary route was used |
| `route_strategy` | `String` | `primary`, `fallback`, or `canary` |

## API Assumptions

- Health: `GET /v1/health`
- Run: `POST /v1/tasks/{task}/run`
- Stream: `POST /v1/tasks/{task}/stream` (SSE)

## Zero Dependencies

This gem uses only Ruby stdlib (`net/http`, `json`, `uri`) — no external gems required. Requires Ruby >= 3.0.

## License

MIT
