# StackSpine Go SDK (`sdk-go`)

Official Go client for **StackSpine** (Multi‑Model AI Control Plane).

## Install

```bash
go get github.com/stackspine/sdk-go
```

## Quickstart

```go
package main

import (
  "context"
  "fmt"
  "log"

  stackspine "github.com/stackspine/sdk-go"
)

func main() {
  c := stackspine.NewClient("YOUR_API_KEY", stackspine.WithBaseURL("https://api.stackspine.com"))

  resp, err := c.Run(context.Background(), "summarize", map[string]any{
    "text": "Hello from StackSpine!",
  }, nil)
  if err != nil {
    log.Fatal(err)
  }
  fmt.Println(resp.Output)
}
```

## Streaming (SSE)

```go
stream, err := c.Stream(context.Background(), "chat", map[string]any{
  "messages": []map[string]any{{"role": "user", "content": "Hi"}},
}, nil)
if err != nil { /* ... */ }

for ev := range stream.Events {
  if ev.Type == "delta" {
    fmt.Print(ev.Data["text"])
  }
}
if stream.Err != nil {
  log.Fatal(stream.Err)
}
```

## Error Handling

```go
import "errors"

resp, err := c.Run(ctx, "task", input, nil)
if err != nil {
  var rle *stackspine.RateLimitError
  var bee *stackspine.BudgetExceededError
  var apfe *stackspine.AllProvidersFailedError

  switch {
  case errors.As(err, &rle):
    fmt.Printf("Rate limited. Retry after %.0fs\n", rle.RetryAfter)
  case errors.As(err, &bee):
    fmt.Printf("Budget exceeded: $%.2f/$%.2f\n", bee.CurrentSpendUSD, bee.LimitUSD)
  case errors.As(err, &apfe):
    fmt.Println("All providers are down")
  default:
    fmt.Printf("API error: %v\n", err)
  }
}
```

## Retry Behavior

The SDK automatically retries on:
- Network errors
- 5xx server errors
- 503 (all providers failed)
- 429 (rate limited) — waits for Retry-After header

Retries use exponential backoff with jitter, capped at 30 seconds.

```go
c := stackspine.NewClient("key",
  stackspine.WithMaxRetries(5),
  stackspine.WithTimeout(90 * time.Second),
)
```

## Response Fields

`RunResponse` includes full observability data:

| Field | Type | Description |
|-------|------|-------------|
| `ID` | `string` | Run ID |
| `Task` | `string` | Task key |
| `Status` | `string` | `succeeded`, `failed`, etc. |
| `Model` | `string` | Model used (e.g., `gpt-4-turbo`) |
| `Provider` | `string` | Provider (e.g., `openai`) |
| `Content` | `string` | Generated text |
| `CostUSD` | `float64` | Cost in USD |
| `LatencyMs` | `float64` | Latency in ms |
| `WasCanary` | `bool` | Whether canary route was used |
| `RouteStrategy` | `string` | `primary`, `fallback`, or `canary` |

## API Assumptions

- Health: `GET /v1/health`
- Run: `POST /v1/tasks/{task}/run`
- Stream: `POST /v1/tasks/{task}/stream` (SSE)

Override via `Client.Do(...)` if your paths differ.

## License

MIT
