from __future__ import annotations

import json
import time
import random
from typing import Any, Dict, Optional, Union, Generator, AsyncGenerator

import httpx
import requests

from .errors import (
    APIError,
    RateLimitError,
    BudgetExceededError,
    AllProvidersFailedError,
    TimeoutError as SDKTimeoutError,
)
from .models import RunResponse, Usage, ErrorResponse, StreamEvent
from .streaming import iter_sse_bytes, aiter_sse_bytes

DEFAULT_BASE_URL = "https://api.stackspine.ai"
DEFAULT_MAX_RETRIES = 3


class _BaseConfig:
    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        max_retries: int = DEFAULT_MAX_RETRIES,
        headers: Optional[Dict[str, str]] = None,
    ):
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.headers = headers or {}

    def auth_headers(self) -> Dict[str, str]:
        h = {"Authorization": f"Bearer {self.api_key}"}
        h.update(self.headers)
        return h


def _backoff_delay(attempt: int, base: float = 1.0) -> float:
    """Exponential backoff with jitter, capped at 30s."""
    delay = base * (2 ** attempt)
    jitter = random.random()
    return min(delay + jitter, 30.0)


def _raise_for_error(status_code: int, body: Any, request_id: Optional[str] = None) -> None:
    """Raise typed errors based on status code."""
    if 200 <= status_code < 300:
        return

    message: str
    details: Optional[Dict[str, Any]] = None
    if isinstance(body, dict):
        message = body.get("message") or body.get("error") or json.dumps(body)
        details = body.get("details")
    else:
        message = str(body)

    if status_code == 429:
        retry_after = 60.0
        if isinstance(body, dict):
            retry_after = float(body.get("retry_after", 60))
        raise RateLimitError(message=message, retry_after=retry_after, request_id=request_id)

    #   spend/limit details. See "Pre-Request Budget Enforcement in a Multi-Model
    #   AI Routing System."
    if status_code == 402:
        limit_usd = float((details or {}).get("limit_usd", 0))
        current = float((details or {}).get("current_spend_usd", 0))
        raise BudgetExceededError(
            message=message, limit_usd=limit_usd, current_spend_usd=current, request_id=request_id,
        )

    if status_code == 503:
        raise AllProvidersFailedError(message=message, request_id=request_id)

    raise APIError(message=message, status_code=status_code, request_id=request_id, details=details)


def _parse_run_response(data: Dict[str, Any], task: str) -> RunResponse:
    """Normalize raw API dict into RunResponse."""
    usage_raw = data.get("usage")
    usage = None
    if isinstance(usage_raw, dict):
        usage = Usage(
            input_tokens=usage_raw.get("input_tokens") or usage_raw.get("prompt_tokens") or 0,
            output_tokens=usage_raw.get("output_tokens") or usage_raw.get("completion_tokens") or 0,
            total_tokens=usage_raw.get("total_tokens") or 0,
        )
    return RunResponse(
        id=str(data.get("id") or data.get("run_id") or ""),
        task=task,
        status=data.get("status") or "succeeded",
        model=data.get("model"),
        provider=data.get("provider"),
        content=data.get("content"),
        output=data.get("output"),
        usage=usage,
        cost_usd=data.get("cost_usd"),
        latency_ms=data.get("latency_ms"),
        was_canary=data.get("was_canary"),
        route_strategy=data.get("route_strategy"),
        raw=data,
    )


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------

class StackSpine:
    """Synchronous StackSpine client (requests)."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        max_retries: int = DEFAULT_MAX_RETRIES,
        headers: Optional[Dict[str, str]] = None,
        session: Optional[requests.Session] = None,
    ):
        self._cfg = _BaseConfig(api_key, base_url, timeout, max_retries, headers)
        self._session = session or requests.Session()

    def close(self) -> None:
        self._session.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- low-level --------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        json_body: Optional[Dict[str, Any]] = None,
        stream: bool = False,
        _attempt: int = 0,
    ) -> Union[Dict[str, Any], requests.Response]:
        url = f"{self._cfg.base_url}{path}"
        accept = "text/event-stream" if stream else "application/json"
        try:
            resp = self._session.request(
                method=method,
                url=url,
                headers={**self._cfg.auth_headers(), "Accept": accept},
                json=json_body,
                timeout=self._cfg.timeout,
                stream=stream,
            )
        except requests.exceptions.Timeout as e:
            raise SDKTimeoutError(self._cfg.timeout) from e
        except requests.exceptions.ConnectionError:
            if _attempt < self._cfg.max_retries:
                time.sleep(_backoff_delay(_attempt))
                return self.request(method, path, json_body, stream, _attempt + 1)
            raise

        request_id = resp.headers.get("x-request-id")

        if stream:
            if resp.status_code >= 300:
                try:
                    body = resp.json()
                except Exception:
                    body = resp.text
                _raise_for_error(resp.status_code, body, request_id)
            return resp

        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}

        # Retry on retryable errors
        if resp.status_code >= 500 or resp.status_code == 429:
            if _attempt < self._cfg.max_retries:
                delay = _backoff_delay(_attempt)
                if resp.status_code == 429:
                    delay = float(resp.headers.get("Retry-After", delay))
                time.sleep(delay)
                return self.request(method, path, json_body, stream, _attempt + 1)

        _raise_for_error(resp.status_code, data, request_id)
        return data

    # -- public API -------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        return self.request("GET", "/v1/health")  # type: ignore[return-value]

    def run(
        self,
        task: str,
        input: Dict[str, Any],
        *,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> RunResponse:
        payload: Dict[str, Any] = {"input": input}
        if metadata:
            payload["metadata"] = metadata
        data = self.request("POST", f"/v1/tasks/{task}/run", json_body=payload)
        if isinstance(data, dict):
            return _parse_run_response(data, task)
        return RunResponse(id="", task=task, status="failed", raw={"unexpected": str(data)})

    def stream(
        self,
        task: str,
        input: Dict[str, Any],
        *,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Generator[StreamEvent, None, None]:
        payload: Dict[str, Any] = {"input": input}
        if metadata:
            payload["metadata"] = metadata

        resp = self.request("POST", f"/v1/tasks/{task}/stream", json_body=payload, stream=True)
        assert isinstance(resp, requests.Response)

        def byte_iter():
            for chunk in resp.iter_content(chunk_size=None):
                if chunk:
                    yield chunk

        yield from iter_sse_bytes(byte_iter())


# ---------------------------------------------------------------------------
# Async client
# ---------------------------------------------------------------------------

class AsyncStackSpine:
    """Asynchronous StackSpine client (httpx + asyncio)."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        max_retries: int = DEFAULT_MAX_RETRIES,
        headers: Optional[Dict[str, str]] = None,
        client: Optional[httpx.AsyncClient] = None,
    ):
        self._cfg = _BaseConfig(api_key, base_url, timeout, max_retries, headers)
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.aclose()

    # -- low-level --------------------------------------------------------

    async def request(
        self,
        method: str,
        path: str,
        json_body: Optional[Dict[str, Any]] = None,
        _attempt: int = 0,
    ) -> Dict[str, Any]:
        """Non-streaming request with retries."""
        import asyncio

        url = f"{self._cfg.base_url}{path}"
        headers = {**self._cfg.auth_headers(), "Accept": "application/json"}

        try:
            resp = await self._client.request(method, url, headers=headers, json=json_body)
        except httpx.TimeoutException as e:
            raise SDKTimeoutError(self._cfg.timeout) from e
        except httpx.ConnectError:
            if _attempt < self._cfg.max_retries:
                await asyncio.sleep(_backoff_delay(_attempt))
                return await self.request(method, path, json_body, _attempt + 1)
            raise

        request_id = resp.headers.get("x-request-id")

        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}

        if resp.status_code >= 500 or resp.status_code == 429:
            if _attempt < self._cfg.max_retries:
                delay = _backoff_delay(_attempt)
                if resp.status_code == 429:
                    delay = float(resp.headers.get("Retry-After", str(delay)))
                await asyncio.sleep(delay)
                return await self.request(method, path, json_body, _attempt + 1)

        _raise_for_error(resp.status_code, data, request_id)
        return data  # type: ignore[return-value]

    # -- public API -------------------------------------------------------

    async def health(self) -> Dict[str, Any]:
        return await self.request("GET", "/v1/health")

    async def run(
        self,
        task: str,
        input: Dict[str, Any],
        *,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> RunResponse:
        payload: Dict[str, Any] = {"input": input}
        if metadata:
            payload["metadata"] = metadata
        data = await self.request("POST", f"/v1/tasks/{task}/run", json_body=payload)
        return _parse_run_response(data, task)

    async def stream(
        self,
        task: str,
        input: Dict[str, Any],
        *,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        payload: Dict[str, Any] = {"input": input}
        if metadata:
            payload["metadata"] = metadata

        url = f"{self._cfg.base_url}/v1/tasks/{task}/stream"
        headers = {**self._cfg.auth_headers(), "Accept": "text/event-stream"}

        # Use httpx streaming context manager — this is the correct approach
        async with self._client.stream("POST", url, headers=headers, json=payload) as resp:
            request_id = resp.headers.get("x-request-id")
            if resp.status_code >= 300:
                body_bytes = await resp.aread()
                try:
                    body = json.loads(body_bytes.decode("utf-8", errors="replace"))
                except Exception:
                    body = {"raw": body_bytes.decode("utf-8", errors="replace")}
                _raise_for_error(resp.status_code, body, request_id)

            async for ev in aiter_sse_bytes(resp.aiter_bytes()):
                yield ev
