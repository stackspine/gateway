from __future__ import annotations

from typing import Any, Dict, List, Optional, Literal
from pydantic import BaseModel, Field


class ErrorResponse(BaseModel):
    error: str
    message: Optional[str] = None
    request_id: Optional[str] = None
    details: Optional[Dict[str, Any]] = None


class Usage(BaseModel):
    """Token usage information."""
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


class RunResponse(BaseModel):
    """Response from /v1/tasks/{task}/run."""
    id: str = Field(..., description="Run id")
    task: str
    status: Literal["queued", "running", "succeeded", "failed"] = "succeeded"
    model: Optional[str] = None
    provider: Optional[str] = None
    content: Optional[str] = None
    output: Optional[Dict[str, Any]] = None
    usage: Optional[Usage] = None
    cost_usd: Optional[float] = None
    latency_ms: Optional[float] = None
    was_canary: Optional[bool] = None
    route_strategy: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None


class StreamEvent(BaseModel):
    """A single SSE event from StackSpine."""
    type: str
    data: Dict[str, Any] = Field(default_factory=dict)
    id: Optional[str] = None
    event: Optional[str] = None
