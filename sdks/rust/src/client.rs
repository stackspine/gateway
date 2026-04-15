use crate::errors::Error;
use crate::models::{Message, RunResponse};
use crate::streaming::SseStream;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

const DEFAULT_BASE_URL: &str = "https://api.stackspine.ai";
const DEFAULT_MAX_RETRIES: u32 = 3;
const DEFAULT_TIMEOUT_SECS: u64 = 60;

/// Builder for configuring a [`StackSpineClient`].
pub struct StackSpineClientBuilder {
    api_key: String,
    base_url: String,
    max_retries: u32,
    timeout: Duration,
}

impl StackSpineClientBuilder {
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into().trim_end_matches('/').to_string();
        self
    }

    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }

    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = d;
        self
    }

    pub fn build(self) -> StackSpineClient {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", self.api_key)).unwrap(),
        );

        let http = reqwest::Client::builder()
            .timeout(self.timeout)
            .default_headers(headers)
            .build()
            .expect("failed to build HTTP client");

        StackSpineClient {
            base_url: self.base_url,
            max_retries: self.max_retries,
            http,
        }
    }
}

/// The StackSpine API client.
pub struct StackSpineClient {
    base_url: String,
    max_retries: u32,
    http: reqwest::Client,
}

impl StackSpineClient {
    /// Create a new client builder with the given API key.
    pub fn builder(api_key: impl Into<String>) -> StackSpineClientBuilder {
        StackSpineClientBuilder {
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            max_retries: DEFAULT_MAX_RETRIES,
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        }
    }

    /// Execute a task synchronously with automatic retries.
    pub async fn run(
        &self,
        task: &str,
        messages: Vec<Message>,
    ) -> Result<RunResponse, Error> {
        self.run_with_metadata(task, messages, None).await
    }

    /// Execute a task with optional metadata.
    pub async fn run_with_metadata(
        &self,
        task: &str,
        messages: Vec<Message>,
        metadata: Option<HashMap<String, Value>>,
    ) -> Result<RunResponse, Error> {
        let url = format!("{}/v1/tasks/{}/run", self.base_url, task);
        let mut payload = json!({
            "input": { "messages": messages }
        });
        if let Some(meta) = metadata {
            payload["metadata"] = json!(meta);
        }

        let mut last_err = None;
        for attempt in 0..=self.max_retries {
            let resp = self
                .http
                .post(&url)
                .header(CONTENT_TYPE, "application/json")
                .header(ACCEPT, "application/json")
                .json(&payload)
                .send()
                .await;

            match resp {
                Ok(r) => {
                    let status = r.status().as_u16();
                    let request_id = r
                        .headers()
                        .get("x-request-id")
                        .and_then(|v| v.to_str().ok())
                        .map(String::from);

                    if status >= 200 && status < 300 {
                        let body: RunResponse = r.json().await?;
                        return Ok(body);
                    }

                    let body_text = r.text().await.unwrap_or_default();
                    let err = parse_error(status, &body_text, request_id);

                    if err.is_retryable() && attempt < self.max_retries {
                        let delay = backoff_delay(attempt);
                        tokio::time::sleep(delay).await;
                        last_err = Some(err);
                        continue;
                    }

                    return Err(err);
                }
                Err(e) if e.is_timeout() => {
                    if attempt < self.max_retries {
                        let delay = backoff_delay(attempt);
                        tokio::time::sleep(delay).await;
                        last_err = Some(Error::Timeout {
                            timeout_secs: DEFAULT_TIMEOUT_SECS as f64,
                        });
                        continue;
                    }
                    return Err(Error::Timeout {
                        timeout_secs: DEFAULT_TIMEOUT_SECS as f64,
                    });
                }
                Err(e) => {
                    if attempt < self.max_retries {
                        let delay = backoff_delay(attempt);
                        tokio::time::sleep(delay).await;
                        last_err = Some(Error::Network(e));
                        continue;
                    }
                    return Err(Error::Network(e));
                }
            }
        }

        Err(last_err.unwrap_or(Error::Validation("max retries exceeded".into())))
    }

    /// Open a streaming task invocation, returning an async stream of events.
    pub async fn stream(
        &self,
        task: &str,
        messages: Vec<Message>,
    ) -> Result<SseStream, Error> {
        let url = format!("{}/v1/tasks/{}/stream", self.base_url, task);
        let payload = json!({
            "input": { "messages": messages }
        });

        let resp = self
            .http
            .post(&url)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "text/event-stream")
            .json(&payload)
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status < 200 || status >= 300 {
            let request_id = resp
                .headers()
                .get("x-request-id")
                .and_then(|v| v.to_str().ok())
                .map(String::from);
            let body_text = resp.text().await.unwrap_or_default();
            return Err(parse_error(status, &body_text, request_id));
        }

        Ok(SseStream::new(resp))
    }

    /// Check API health.
    pub async fn health(&self) -> Result<HashMap<String, Value>, Error> {
        let url = format!("{}/v1/health", self.base_url);
        let resp = self.http.get(&url).send().await?;
        let body: HashMap<String, Value> = resp.json().await?;
        Ok(body)
    }
}

fn backoff_delay(attempt: u32) -> Duration {
    let base_ms = 2u64.pow(attempt) * 1000;
    let jitter_ms = rand_jitter();
    Duration::from_millis((base_ms + jitter_ms).min(30_000))
}

fn rand_jitter() -> u64 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 % 1000)
        .unwrap_or(500)
}

fn parse_error(status: u16, body: &str, request_id: Option<String>) -> Error {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let message = parsed["message"]
        .as_str()
        .or_else(|| parsed["error"].as_str())
        .unwrap_or(body)
        .to_string();

    match status {
        429 => Error::RateLimit {
            message,
            request_id,
            retry_after: parsed["retry_after"].as_f64().unwrap_or(60.0),
        },
        // [Patent 1, Claim 1(f)] — Structured 402 BUDGET_EXCEEDED response.
        // See "Pre-Request Budget Enforcement in a Multi-Model AI Routing System."
        402 => Error::BudgetExceeded {
            message,
            request_id,
            limit_usd: parsed["limit_usd"].as_f64().unwrap_or(0.0),
            current_spend_usd: parsed["current_spend_usd"].as_f64().unwrap_or(0.0),
        },
        503 => Error::AllProvidersFailed {
            message,
            request_id,
        },
        _ => Error::Api {
            status,
            message,
            request_id,
        },
    }
}
