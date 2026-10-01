"""
Workflow Functions
==================

Deterministic step executors for Studio-built workflows. The workflow runtime
calls each one as ``func(step_input)``; each returns the step's text content.

Failures return text starting with ``"Error: "`` so a workflow can branch on
``previous_step_content.startsWith("Error: ")`` instead of crashing.
"""

from __future__ import annotations

import json
import re
from typing import Any

from agno.workflow import StepInput
from pydantic import BaseModel

ERROR_PREFIX = "Error: "
_URL_PATTERN = re.compile(r"https?://[^\s<>\"')\]]+")
_NO_JSON = object()


def step_text(step_input: StepInput) -> str:
    """Return the text a step operates on: the previous step's output, else the workflow input.

    Args:
        step_input: The workflow runtime's input for this step.

    Returns:
        Plain text; structured values are serialized as indented JSON.
    """
    content = step_input.previous_step_content
    if content is None:
        return step_input.get_input_as_string() or ""
    if isinstance(content, BaseModel):
        return content.model_dump_json(indent=2, exclude_none=True)
    if isinstance(content, (dict, list)):
        return json.dumps(content, indent=2, default=str, ensure_ascii=False)
    return str(content)


def largest_json(text: str) -> Any:
    """Decode the largest JSON object or array embedded in ``text``.

    "Largest" rather than "first" so incidental brackets such as ``[1]`` citations
    do not win over the real payload.

    Args:
        text: Free text that may contain JSON.

    Returns:
        The decoded value, or the ``_NO_JSON`` sentinel when nothing decodes.
    """
    decoder = json.JSONDecoder()
    best_span, best_value, skip_until = 0, _NO_JSON, 0
    for match in re.finditer(r"[\[{]", text):
        start = match.start()
        if start < skip_until:
            continue
        try:
            value, end = decoder.raw_decode(text, start)
        except json.JSONDecodeError:
            continue
        if end - start > best_span:
            best_span, best_value = end - start, value
        skip_until = end
    return best_value


def extract_json(step_input: StepInput) -> str:
    """Return the largest JSON object or array in the previous step's output, pretty-printed.

    Place it between a gathering agent and any step that needs structured input.
    An upstream ``Error: `` passes through unchanged.

    Returns:
        Indented JSON, or ``"Error: ..."`` when no JSON decodes.
    """
    text = step_text(step_input)
    if text.startswith(ERROR_PREFIX):
        return text
    value = largest_json(text)
    if value is _NO_JSON:
        return f"{ERROR_PREFIX}no valid JSON object or array in the previous step's output"
    return json.dumps(value, indent=2, ensure_ascii=False)


def extract_urls(step_input: StepInput) -> str:
    """Return the URLs in the previous step's output, de-duplicated in order, one per line.

    An upstream ``Error: `` passes through unchanged.

    Returns:
        Newline-separated URLs, or ``"Error: ..."`` when there are none.
    """
    text = step_text(step_input)
    if text.startswith(ERROR_PREFIX):
        return text
    urls = dict.fromkeys(url.rstrip(".,;:!?`*") for url in _URL_PATTERN.findall(text))
    if not urls:
        return f"{ERROR_PREFIX}no URLs in the previous step's output"
    return "\n".join(urls)
