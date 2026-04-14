from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, Generator, AsyncGenerator, Iterable, Optional, Tuple

from .errors import StreamError
from .models import StreamEvent


def _parse_sse_lines(buffer: str) -> Tuple[Optional[StreamEvent], str]:
    """Parse a single SSE event from buffer. Returns (event_or_none, remainder)."""
    sep = "\n\n"
    idx = buffer.find(sep)
    if idx == -1:
        return None, buffer

    raw_event = buffer[:idx]
    remainder = buffer[idx + len(sep):]

    event_type: Optional[str] = None
    event_id: Optional[str] = None
    event_name: Optional[str] = None
    data_lines: list[str] = []

    for line in raw_event.splitlines():
        if not line or line.startswith(":"):
            continue
        if ":" in line:
            field, value = line.split(":", 1)
            value = value.lstrip()
        else:
            field, value = line, ""

        if field == "event":
            event_name = value
        elif field == "id":
            event_id = value
        elif field == "type":
            event_type = value
        elif field == "data":
            data_lines.append(value)

    data_str = "\n".join(data_lines).strip()
    if data_str in ("", "[DONE]"):
        return StreamEvent(type=event_type or event_name or "done", data={}), remainder

    data: Dict[str, Any]
    try:
        decoded = json.loads(data_str)
        if isinstance(decoded, dict):
            data = decoded
        else:
            data = {"value": decoded}
    except json.JSONDecodeError:
        data = {"text": data_str}

    ev = StreamEvent(
        type=event_type or event_name or "message",
        data=data,
        id=event_id,
        event=event_name,
    )
    return ev, remainder


def iter_sse_bytes(
    byte_iter: Iterable[bytes], encoding: str = "utf-8"
) -> Generator[StreamEvent, None, None]:
    """Convert an iterable of bytes (HTTP response body) into StreamEvent objects."""
    buffer = ""
    for chunk in byte_iter:
        if not chunk:
            continue
        try:
            buffer += chunk.decode(encoding, errors="replace")
        except Exception as e:
            raise StreamError(f"Failed decoding stream: {e}") from e

        while True:
            ev, buffer = _parse_sse_lines(buffer)
            if ev is None:
                break
            yield ev


async def aiter_sse_bytes(
    byte_iter: AsyncIterator[bytes], encoding: str = "utf-8"
) -> AsyncGenerator[StreamEvent, None]:
    """Convert an async iterator of bytes into StreamEvent objects."""
    buffer = ""
    async for chunk in byte_iter:
        if not chunk:
            continue
        try:
            buffer += chunk.decode(encoding, errors="replace")
        except Exception as e:
            raise StreamError(f"Failed decoding stream: {e}") from e

        while True:
            ev, buffer = _parse_sse_lines(buffer)
            if ev is None:
                break
            yield ev
