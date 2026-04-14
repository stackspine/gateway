use thiserror::Error as ThisError;

/// All errors returned by the StackSpine SDK.
#[derive(Debug, ThisError)]
pub enum Error {
    /// HTTP or network error from reqwest.
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    /// API returned an error response.
    #[error("api error (status {status}): {message}")]
    Api {
        status: u16,
        message: String,
        request_id: Option<String>,
    },

    /// Rate limited (HTTP 429). Contains retry delay in seconds.
    #[error("rate limited (retry after {retry_after}s): {message}")]
    RateLimit {
        message: String,
        request_id: Option<String>,
        retry_after: f64,
    },

    /// Budget exceeded (HTTP 402).
    #[error("budget exceeded (limit=${limit_usd:.2}, spent=${current_spend_usd:.2}): {message}")]
    BudgetExceeded {
        message: String,
        request_id: Option<String>,
        limit_usd: f64,
        current_spend_usd: f64,
    },

    /// All configured providers failed (HTTP 503).
    #[error("all providers failed: {message}")]
    AllProvidersFailed {
        message: String,
        request_id: Option<String>,
    },

    /// Request timed out after configured duration.
    #[error("request timed out after {timeout_secs}s")]
    Timeout { timeout_secs: f64 },

    /// Client-side validation error.
    #[error("validation error: {0}")]
    Validation(String),

    /// SSE stream parsing error.
    #[error("stream error: {0}")]
    Stream(String),

    /// JSON serialization/deserialization error.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl Error {
    /// Whether this error is retryable.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Error::RateLimit { .. }
                | Error::AllProvidersFailed { .. }
                | Error::Timeout { .. }
                | Error::Network(_)
        )
    }
}
