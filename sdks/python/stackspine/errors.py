from __future__ import annotations

from typing import Any, Dict, Optional


class StackSpineError(Exception):
    """Base SDK error."""


class APIError(StackSpineError):
    """Generic API error with status code and optional request ID."""

    def __init__(
        self,
        message: str,
        status_code: int,
        request_id: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.request_id = request_id
        self.details = details

    @property
    def is_retryable(self) -> bool:
        return self.status_code in (429, 503) or self.status_code >= 500


class RateLimitError(APIError):
    """Raised when the server returns 429 Too Many Requests."""

    def __init__(
        self,
        message: str = "Rate limit exceeded",
        retry_after: float = 60.0,
        request_id: Optional[str] = None,
    ):
        super().__init__(message, status_code=429, request_id=request_id)
        self.retry_after = retry_after


class BudgetExceededError(APIError):
    """Raised when the spend budget is exhausted (402)."""

    def __init__(
        self,
        message: str = "Budget exceeded",
        limit_usd: float = 0.0,
        current_spend_usd: float = 0.0,
        request_id: Optional[str] = None,
    ):
        super().__init__(
            message,
            status_code=402,
            request_id=request_id,
            details={"limit_usd": limit_usd, "current_spend_usd": current_spend_usd},
        )
        self.limit_usd = limit_usd
        self.current_spend_usd = current_spend_usd


class AllProvidersFailedError(APIError):
    """Raised when all configured providers are unavailable (503)."""

    def __init__(
        self,
        message: str = "All configured providers are unavailable",
        request_id: Optional[str] = None,
    ):
        super().__init__(message, status_code=503, request_id=request_id)


class TimeoutError(StackSpineError):
    """Raised when a request exceeds the configured timeout."""

    def __init__(self, timeout_seconds: float):
        super().__init__(f"Request timed out after {timeout_seconds}s")
        self.timeout_seconds = timeout_seconds


class ValidationError(StackSpineError):
    """Client-side validation error (never sent to server)."""
    pass


class StreamError(StackSpineError):
    """Error during SSE stream parsing."""
    pass
