//! # StackSpine SDK for Rust
//!
//! Official Rust client for the StackSpine multi-model AI control plane.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use stackspine::{StackSpineClient, Message};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), stackspine::Error> {
//!     let client = StackSpineClient::builder(std::env::var("STACKSPINE_API_KEY").unwrap())
//!         .build();
//!
//!     let response = client.run("chat-support", vec![
//!         Message::user("Hello!"),
//!     ]).await?;
//!
//!     println!("{}", response.content.unwrap_or_default());
//!     Ok(())
//! }
//! ```

pub mod client;
pub mod errors;
pub mod models;
pub mod streaming;

pub use client::{StackSpineClient, StackSpineClientBuilder};
pub use errors::Error;
pub use models::{Message, RunResponse, StreamEvent, Usage};
