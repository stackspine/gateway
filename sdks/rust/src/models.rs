use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

impl Message {
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user".into(), content: content.into() }
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self { role: "system".into(), content: content.into() }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: content.into() }
    }
}

/// Token usage information.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

/// Response from a synchronous task invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResponse {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub status: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub content: Option<String>,
    pub output: Option<HashMap<String, serde_json::Value>>,
    pub usage: Option<Usage>,
    pub cost_usd: Option<f64>,
    pub latency_ms: Option<f64>,
    pub was_canary: Option<bool>,
    pub route_strategy: Option<String>,
}

/// A single SSE event from the streaming API.
#[derive(Debug, Clone)]
pub struct StreamEvent {
    pub event_type: String,
    pub data: HashMap<String, serde_json::Value>,
    pub id: Option<String>,
    pub done: bool,
}

impl StreamEvent {
    /// Extract the text content from this event, if present.
    pub fn content(&self) -> Option<&str> {
        self.data
            .get("content")
            .and_then(|v| v.as_str())
    }

    /// Extract usage information from the final event.
    pub fn usage(&self) -> Option<Usage> {
        self.data
            .get("usage")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }
}
