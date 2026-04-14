# Changelog

All notable changes to the StackSpine Gateway will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-04-14

### Added

- **Multi-provider routing** — Primary, canary (weighted), and fallback strategies
- **Circuit breaker** — 3-state (closed/open/half-open) per-provider with configurable threshold and cooldown
- **Pre-request budget enforcement** — Blocks requests (HTTP 402) when monthly spend exceeds configured limits *(Patent Pending)*
- **Pre-request cost projection** — Predicts token usage and selects cheapest qualifying model when confidence is high *(Patent Pending)*
- **Rate limiting** — Per-IP and per-API-key with sliding window (database-backed)
- **Compliance pre-scan** — PII detection/redaction, topic blocking, competitor mention filtering, profanity filtering
- **Prompt caching** — SHA-256 exact-match cache with configurable TTL
- **Session limits** — Per-session iteration and budget caps
- **Context portability** — Automatic conversation compression for models with smaller context windows
- **Streaming** — SSE passthrough with accurate token tracking via TransformStream
- **Conditional routing** — Route selection based on metadata, region, time, and custom conditions
- **Data policy routing** — GDPR/HIPAA-aware route filtering based on allowed regions
- **Region detection** — Automatic via Cloudflare `cf-ipcountry` header or explicit `X-Region`
- **W3C tracing** — `traceparent` and `X-Trace-Id` headers on every response
- **Idempotency** — Replay cached responses for duplicate requests
- **Self-hosting** — Docker Compose and Helm chart included
- **SDKs** — JavaScript, Python, Go, Ruby, and Rust clients
