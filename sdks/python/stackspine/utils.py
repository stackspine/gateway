from __future__ import annotations

from typing import Any, Dict


def model_to_dict(model: Any) -> Dict[str, Any]:
    """Pydantic v1/v2 compatibility: return a plain dict."""
    if model is None:
        return {}
    if hasattr(model, "model_dump"):  # pydantic v2
        return model.model_dump(exclude_none=True)  # type: ignore[attr-defined]
    if hasattr(model, "dict"):  # pydantic v1
        return model.dict(exclude_none=True)  # type: ignore[no-any-return]
    raise TypeError("Expected a pydantic model or compatible object")
