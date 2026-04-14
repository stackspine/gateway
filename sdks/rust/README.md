# StackSpine SDK for Rust

Official Rust client for the [StackSpine](https://stackspine.com) multi-model AI control plane.

## Installation

```bash
cargo add stackspine
```

## Quick Start

```rust
use stackspine::{StackSpineClient, Message};

#[tokio::main]
async fn main() -> Result<(), stackspine::Error> {
    let client = StackSpineClient::builder(std::env::var("STACKSPINE_API_KEY").unwrap())
        .build();

    let response = client.run("chat-support", vec![
        Message::user("Hello!"),
    ]).await?;

    println!("{}", response.content.unwrap_or_default());
    println!("Cost: ${:.4}", response.cost_usd.unwrap_or(0.0));
    Ok(())
}
```

## Streaming

```rust
use futures::StreamExt;
use stackspine::{StackSpineClient, Message};

#[tokio::main]
async fn main() -> Result<(), stackspine::Error> {
    let client = StackSpineClient::builder(std::env::var("STACKSPINE_API_KEY").unwrap())
        .build();

    let mut stream = client.stream("chat-support", vec![
        Message::user("Hello!"),
    ]).await?;

    while let Some(event) = stream.next().await {
        let event = event?;
        if let Some(text) = event.content() {
            print!("{}", text);
        }
        if event.done {
            if let Some(usage) = event.usage() {
                println!("\nTokens: {}", usage.total_tokens);
            }
        }
    }
    Ok(())
}
```

## Error Handling

```rust
use stackspine::Error;

match client.run("chat-support", messages).await {
    Ok(resp) => println!("{}", resp.content.unwrap_or_default()),
    Err(Error::RateLimit { retry_after, .. }) => {
        println!("Rate limited, retry after {}s", retry_after);
    }
    Err(Error::BudgetExceeded { limit_usd, current_spend_usd, .. }) => {
        println!("Budget exceeded: ${:.2}/${:.2}", current_spend_usd, limit_usd);
    }
    Err(Error::AllProvidersFailed { .. }) => {
        println!("All AI providers are unavailable");
    }
    Err(e) => eprintln!("Error: {}", e),
}
```

## Configuration

```rust
use std::time::Duration;

let client = StackSpineClient::builder("your_api_key")
    .base_url("https://api.stackspine.com")
    .max_retries(5)
    .timeout(Duration::from_secs(120))
    .build();
```

## License

MIT
