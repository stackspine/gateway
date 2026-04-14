# @stackspine/sdk

Official TypeScript/JavaScript SDK for the StackSpine API.

## Installation

```bash
npm install @stackspine/sdk
# or
yarn add @stackspine/sdk
# or
pnpm add @stackspine/sdk
```

## Quick Start

```typescript
import { StackSpine } from '@stackspine/sdk';

const client = new StackSpine({
  apiKey: process.env.STACKSPINE_API_KEY!,
});

// Simple invocation
const response = await client.invoke('chat-support', [
  { role: 'user', content: 'Hello, how can you help me?' }
]);

console.log(response.content);
console.log(`Cost: $${response.cost_usd}`);
```

## Features

- ✅ Type-safe API calls
- ✅ Automatic retries with exponential backoff
- ✅ Streaming support (async iterators)
- ✅ Comprehensive error handling
- ✅ Usage metrics API
- ✅ Zero dependencies

## API Reference

### Constructor

```typescript
const client = new StackSpine({
  apiKey: string;       // Required: Your API key
  baseUrl?: string;     // Optional: Custom base URL
  timeout?: number;     // Optional: Request timeout (default: 30000ms)
  maxRetries?: number;  // Optional: Max retry attempts (default: 3)
});
```

### invoke()

Execute an AI inference request.

```typescript
const response = await client.invoke(
  'task-key',
  [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' }
  ],
  {
    max_tokens: 1000,
    temperature: 0.7,
    metadata: { user_id: '123' }
  }
);

console.log(response.content);     // Generated text
console.log(response.model);       // e.g., 'gpt-4-turbo'
console.log(response.provider);    // e.g., 'openai'
console.log(response.cost_usd);    // e.g., 0.00075
console.log(response.latency_ms);  // e.g., 1234
```

### stream()

Stream responses using async iterators.

```typescript
for await (const chunk of client.stream('chat-support', messages)) {
  process.stdout.write(chunk.content);
  
  if (chunk.done) {
    console.log('\n\nUsage:', chunk.usage);
  }
}
```

Or collect the entire stream:

```typescript
import { collectStream } from '@stackspine/sdk';

const stream = client.stream('chat-support', messages);
const { text, usage } = await collectStream(stream);

console.log(text);
console.log(usage);
```

### getUsage()

Retrieve usage metrics for a time period.

```typescript
const usage = await client.getUsage({
  start_date: '2026-01-01',
  end_date: '2026-01-31',
  group_by: 'task'  // 'task' | 'provider' | 'model' | 'day'
});

console.log(`Total requests: ${usage.total_requests}`);
console.log(`Total cost: $${usage.total_cost_usd}`);

for (const group of usage.by_group) {
  console.log(`${group.key}: ${group.requests} requests, $${group.cost_usd}`);
}
```

## Error Handling

The SDK provides specific error types for different failure modes:

```typescript
import {
  StackSpineError,
  AuthenticationError,
  RateLimitError,
  BudgetExceededError,
  AllProvidersFailedError,
  TimeoutError
} from '@stackspine/sdk';

try {
  const response = await client.invoke('task', messages);
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log(`Rate limited. Retry after ${error.retryAfter} seconds`);
  } else if (error instanceof BudgetExceededError) {
    console.log(`Budget exceeded: $${error.currentSpendUsd}/$${error.limitUsd}`);
  } else if (error instanceof AllProvidersFailedError) {
    console.log('All providers are down');
  } else if (error instanceof StackSpineError) {
    console.log(`API error: ${error.code} - ${error.message}`);
  }
}
```

## Retry Behavior

The SDK automatically retries requests on:

- Network errors
- 5xx server errors
- 503 (all providers failed)
- 429 (rate limited) - waits for Retry-After header

Retries use exponential backoff with jitter, capped at 30 seconds.

```typescript
const client = new StackSpine({
  apiKey: 'xxx',
  maxRetries: 5,    // Increase retry attempts
  timeout: 60000,   // Increase timeout to 60s
});
```

## TypeScript

Full TypeScript support with exported types:

```typescript
import type {
  Message,
  InvokeRequest,
  InvokeResponse,
  StreamChunk,
  UsageMetrics,
  UsageParams,
  StackSpineConfig
} from '@stackspine/sdk';
```

## License

MIT
