use crate::errors::Error;
use crate::models::StreamEvent;
use futures::stream::Stream;
use reqwest::Response;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::BufReader;
use tokio_util::io::StreamReader;
use futures::TryStreamExt;

/// An async stream of SSE events from StackSpine.
pub struct SseStream {
    inner: Pin<Box<dyn Stream<Item = Result<StreamEvent, Error>> + Send>>,
}

impl SseStream {
    pub(crate) fn new(response: Response) -> Self {
        let byte_stream = response
            .bytes_stream()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
        let reader = BufReader::new(StreamReader::new(byte_stream));

        let stream = async_stream::try_stream! {
            let mut lines = reader.lines();
            let mut event_type = String::new();
            let mut data_lines: Vec<String> = Vec::new();
            let mut event_id: Option<String> = None;

            while let Some(line) = lines.next_line().await
                .map_err(|e| Error::Stream(e.to_string()))? {

                if line.is_empty() {
                    // Flush event
                    if !data_lines.is_empty() || !event_type.is_empty() {
                        let data_str = data_lines.join("\n");
                        let done = data_str == "[DONE]" || event_type == "done";

                        let data: HashMap<String, serde_json::Value> = if done || data_str.is_empty() {
                            HashMap::new()
                        } else {
                            serde_json::from_str(&data_str).unwrap_or_else(|_| {
                                let mut m = HashMap::new();
                                m.insert("text".to_string(), serde_json::Value::String(data_str.clone()));
                                m
                            })
                        };

                        let ev_type = if event_type.is_empty() {
                            if done { "done" } else { "message" }
                        } else {
                            &event_type
                        };

                        yield StreamEvent {
                            event_type: ev_type.to_string(),
                            data,
                            id: event_id.take(),
                            done,
                        };

                        event_type = String::new();
                        data_lines.clear();
                    }
                    continue;
                }

                if line.starts_with(':') {
                    continue; // SSE comment
                }

                if let Some((field, value)) = line.split_once(':') {
                    let value = value.strip_prefix(' ').unwrap_or(value);
                    match field {
                        "event" => event_type = value.to_string(),
                        "data" => data_lines.push(value.to_string()),
                        "id" => event_id = Some(value.to_string()),
                        _ => {}
                    }
                }
            }

            // Flush remaining
            if !data_lines.is_empty() || !event_type.is_empty() {
                let data_str = data_lines.join("\n");
                let done = data_str == "[DONE]" || event_type == "done";
                let data: HashMap<String, serde_json::Value> = if done || data_str.is_empty() {
                    HashMap::new()
                } else {
                    serde_json::from_str(&data_str).unwrap_or_default()
                };

                yield StreamEvent {
                    event_type: if event_type.is_empty() { "done".to_string() } else { event_type },
                    data,
                    id: event_id,
                    done: true,
                };
            }
        };

        Self {
            inner: Box::pin(stream),
        }
    }
}

impl Stream for SseStream {
    type Item = Result<StreamEvent, Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}
