<p align="center">
  <h1 align="center">StackSpine Gateway</h1>
  <p align="center">
    Open-source AI control plane — multi-provider routing, budget enforcement, and compliance guardrails.
  </p>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#sdks">SDKs</a> ·
  <a href="https://stackspine.com">Managed Cloud</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## What is StackSpine Gateway?

StackSpine Gateway is a **task-level AI control plane** that sits between your application and AI providers. Instead of calling OpenAI/Anthropic/Google directly, you define **tasks** (like `summarize-ticket` or `chat-support`) and StackSpine routes each request to the optimal model based on cost, latency, compliance rules, and provider health.

```
┌─────────────────┐     ┌──────────────────────────┐     ┌──────────────┐
│   Your App      │────▶│  StackSpine Gateway      │────▶│  OpenAI      │
│                 │     │                          │────▶│  Anthropic   │
│  POST /v1/tasks │     │  • Route selection       │────▶│  Google      │
│  /chat/run      │     │  • Budget enforcement    │────▶│  Mistral     │
│                 │     │  • Compliance scanning   │────▶│  Groq        │
│                 │     │  • Circuit breakers      │────▶│  Any OpenAI- │
└─────────────────┘     │  • Cost optimization     │     │  compatible  │
                        └──────────────────────────┘     └──────────────┘
                                     │
                              ┌──────▼───────┐
                              │  PostgreSQL  │
                              │  (Supabase)  │
                              └──────────────┘
```

## Features

| Feature | Description |
|---------|-------------|
| **Multi-provider routing** | Primary, canary (weighted A/B), and fallback strategies |
| **Circuit breaker** | 3-state (closed/open/half-open) per provider with configurable threshold |
| **Budget enforcement** ⚡ | Pre-request blocking (HTTP 402) when spend exceeds limits *(Patent Pending)* |
| **Cost optimization** ⚡ | Auto-selects cheapest qualifying model when confidence is high *(Patent Pending)* |
| **Rate limiting** | Per-IP and per-API-key with sliding window |
| **Compliance guardrails** | PII detection/redaction, topic blocking, profanity filtering |
| **Prompt caching** | SHA-256 exact-match cache with configurable TTL |
| **Session limits** | Per-session iteration and budget caps |
| **Context portability** | Auto-compresses conversations for smaller context windows |
| **Streaming** | SSE passthrough with accurate token tracking |
| **Conditional routing** | Route based on metadata, region, time of day |
| **Data policy routing** | GDPR/HIPAA-aware filtering by allowed regions |
| **Region detection** | Automatic via Cloudflare headers or explicit `X-Region` |
| **W3C tracing** | `traceparent` and `X-Trace-Id` on every response |
| **Idempotency** | Replay cached responses for duplicate requests |

> ⚡ **Patent Pending** — StackSpine's pre-request cost projection and budget enforcement technology is the subject of pending patent applications. See [LICENSE](LICENSE) for the Apache 2.0 patent grant.

## Quick Start

### Docker Compose (5 minutes)

```bash
cd deploy/docker

# Configure
cp .env.example .env
# Edit .env with your PostgreSQL password and JWT secret

# Start
docker compose up -d

# Apply schema
psql -h localhost -U postgres -d stackspine -f ../../migrations/000_core_schema.sql
```

The gateway is now running at `http://localhost:8000`.

### First API Call

```bash
# 1. Create an organization, task, provider, and API key via PostgREST or psql
# 2. Call the gateway:

curl -X POST http://localhost:8000 \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk_your_api_key_here" \
  -d '{
    "task_key": "chat-support",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## SDKs

Official clients for 5 languages:

### JavaScript / TypeScript

```bash
npm install stackspine
```

```typescript
import { StackSpine } from 'stackspine';

const client = new StackSpine({ apiKey: process.env.STACKSPINE_API_KEY });
const response = await client.run('chat-support', [
  { role: 'user', content: 'Hello!' }
]);
console.log(response.content);
```

### Python

```bash
pip install stackspine
```

```python
from stackspine import StackSpine

client = StackSpine(api_key=os.environ["STACKSPINE_API_KEY"])
response = client.run("chat-support", [
    {"role": "user", "content": "Hello!"}
])
print(response.content)
```

### Go

```bash
go get github.com/stackspine/sdk-go
```

```go
client := stackspine.NewClient(os.Getenv("STACKSPINE_API_KEY"))
resp, _ := client.Run(ctx, "chat-support", []stackspine.Message{
    {Role: "user", Content: "Hello!"},
})
fmt.Println(resp.Content)
```

### Ruby

```bash
gem install stackspine
```

```ruby
client = StackSpine::Client.new(api_key: ENV["STACKSPINE_API_KEY"])
response = client.run("chat-support", [
  { role: "user", content: "Hello!" }
])
puts response.content
```

### Rust

```bash
cargo add stackspine
```

```rust
let client = StackSpineClient::builder(std::env::var("STACKSPINE_API_KEY").unwrap()).build();
let response = client.run("chat-support", vec![Message::user("Hello!")]).await?;
println!("{}", response.content.unwrap_or_default());
```

## Self-Hosting

See [deploy/SELF-HOST.md](deploy/SELF-HOST.md) for Docker Compose and Kubernetes (Helm) deployment guides.

## StackSpine Cloud

Don't want to self-host? **[StackSpine Cloud](https://stackspine.com)** provides:

- 📊 **Dashboard** — Real-time analytics, cost attribution, and model performance charts
- 🔐 **SSO/SAML/OIDC** — Enterprise single sign-on
- 📱 **Mobile apps** — Native iOS and Android with push-based incident alerts
- 🧪 **A/B testing** — Canary experiments with statistical significance tracking
- 📋 **Compliance center** — Audit logs, data residency, and GDPR/HIPAA compliance reports
- 📧 **Weekly digests** — Automated cost and performance summaries
- ⚙️ **Auto-scaling** — Managed infrastructure with zero ops

## Architecture

The gateway is a single Deno edge function that:

1. **Authenticates** — SHA-256 timing-safe API key validation
2. **Rate limits** — Atomic check-and-increment in PostgreSQL
3. **Enforces budgets** — Queries `daily_call_stats` aggregation table (~31 rows/month) to project cost *(Patent Pending)*
4. **Scans compliance** — PII detection, topic blocking, profanity filtering
5. **Selects route** — Conditional → canary (weighted) → primary → fallback
6. **Calls provider** — OpenAI, Anthropic, Google, Mistral, Groq, or any OpenAI-compatible endpoint
7. **Logs & aggregates** — Insert to `call_logs`, triggers auto-update `daily_*_stats`

All pre-flight checks are consolidated into a single `resolve_invoke_context` RPC (one database round-trip, ~10-30ms).

## License

Apache License 2.0 — see [LICENSE](LICENSE).

The Apache 2.0 license includes an explicit **patent grant** (Section 3), which protects both users and contributors. StackSpine's pre-request cost projection and budget enforcement technology is the subject of pending patent applications.

---

Built by [StackSpine](https://stackspine.com) · [Documentation](https://docs.stackspine.com) · [Changelog](CHANGELOG.md)
