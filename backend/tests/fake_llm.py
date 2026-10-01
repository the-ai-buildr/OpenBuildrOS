"""
Fake OpenRouter
===============

A tiny OpenAI-compatible ``/chat/completions`` server with scripted behavior, so the
test suite and the docker e2e stack can exercise real agent runs without network
access or an API key.

Script (applied to the latest message):

- a ``tool`` message (a tool result came back) → reply ``"published: <tool result>"``;
- a user message ``BUILD: <name>`` (or the UI form's ``... new agent named "<name>"``)
  while ``create_agent`` is offered → call ``create_agent(name=<name>, publish=true, ...)``;
- a user message ``ARCHIVE: <component id>`` while ``archive_component`` is offered →
  call ``archive_component(component_id=<id>)`` (a confirmation-gated tool);
- anything else → reply ``"Echo: <user message>"``.

A user message starting with ``SLOW`` streams its words 0.2 s apart, long enough
for tests to drop the connection or cancel the run mid-stream.

Run standalone with ``uvicorn tests.fake_llm:app --port 9999``.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="Fake OpenRouter")

BUILD_PREFIX = "BUILD:"
ARCHIVE_PREFIX = "ARCHIVE:"
SLOW_PREFIX = "SLOW"
SLOW_DELAY_SECONDS = 0.2
FORM_NAME = re.compile(r'new agent named "([^"]+)"')


def _text(content: Any) -> str:
    """Flatten OpenAI message content (string or list of parts) to plain text."""
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content or "")


def plan_reply(body: dict[str, Any]) -> dict[str, Any]:
    """Decide the assistant's next message for a chat-completions request body.

    Args:
        body: The parsed request JSON (``messages``, optional ``tools``).

    Returns:
        ``{"content": str}`` or ``{"tool_call": {"name": str, "arguments": dict}}``.
    """
    messages = body.get("messages") or []
    last = messages[-1] if messages else {}
    if last.get("role") == "tool":
        return {"content": f"published: {_text(last.get('content'))}"}

    user_text = _text(last.get("content")).strip()
    tool_names = {tool.get("function", {}).get("name") for tool in body.get("tools") or []}
    form_match = FORM_NAME.search(user_text)
    if form_match:
        name = form_match.group(1)
    elif user_text.startswith(BUILD_PREFIX):
        name = user_text[len(BUILD_PREFIX) :].strip().splitlines()[0] or "Test Agent"
    else:
        name = None
    if name and "create_agent" in tool_names:
        return {
            "tool_call": {
                "name": "create_agent",
                "arguments": {
                    "name": name,
                    "instructions": f"You are {name}. Answer briefly.",
                    "description": f"{name}, built by the fake model.",
                    "publish": True,
                },
            }
        }
    if user_text.startswith(ARCHIVE_PREFIX) and "archive_component" in tool_names:
        component_id = user_text[len(ARCHIVE_PREFIX) :].strip()
        return {"tool_call": {"name": "archive_component", "arguments": {"component_id": component_id}}}
    return {"content": f"Echo: {user_text}"}


def _usage() -> dict[str, int]:
    return {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}


def _tool_call(plan: dict[str, Any], call_id: str) -> dict[str, Any]:
    """The OpenAI ``tool_calls`` entry for a planned tool call."""
    call = plan["tool_call"]
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": call["name"], "arguments": json.dumps(call["arguments"])},
    }


def _finish_reason(plan: dict[str, Any]) -> str:
    return "tool_calls" if "tool_call" in plan else "stop"


def _message(plan: dict[str, Any], call_id: str) -> dict[str, Any]:
    """Build a non-streaming assistant message for ``plan``."""
    if "tool_call" in plan:
        return {"role": "assistant", "content": None, "tool_calls": [_tool_call(plan, call_id)]}
    return {"role": "assistant", "content": plan["content"]}


async def _stream(
    plan: dict[str, Any], model: str, completion_id: str, call_id: str, delay: float = 0.0
) -> AsyncIterator[str]:
    """Yield SSE ``chat.completion.chunk`` events for ``plan``, ``delay`` seconds apart per word."""

    def chunk(delta: dict[str, Any], finish: str | None = None, usage: bool = False) -> str:
        payload: dict[str, Any] = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        if usage:
            payload["usage"] = _usage()
        return f"data: {json.dumps(payload)}\n\n"

    yield chunk({"role": "assistant", "content": ""})
    if "tool_call" in plan:
        yield chunk({"tool_calls": [{"index": 0, **_tool_call(plan, call_id)}]})
    else:
        for word in plan["content"].split(" "):
            await asyncio.sleep(delay)
            yield chunk({"content": word + " "})
    yield chunk({}, finish=_finish_reason(plan), usage=True)
    yield "data: [DONE]\n\n"


@app.post("/chat/completions")
@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Any:
    """OpenAI-compatible chat completions endpoint (streaming and non-streaming)."""
    body = await request.json()
    plan = plan_reply(body)
    model = body.get("model", "fake/model")
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    call_id = f"call_{uuid.uuid4().hex[:12]}"
    if body.get("stream"):
        last_text = _text((body.get("messages") or [{}])[-1].get("content"))
        delay = SLOW_DELAY_SECONDS if last_text.startswith(SLOW_PREFIX) else 0.0
        stream = _stream(plan, model, completion_id, call_id, delay)
        return StreamingResponse(stream, media_type="text/event-stream")
    return JSONResponse(
        {
            "id": completion_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "message": _message(plan, call_id), "finish_reason": _finish_reason(plan)}],
            "usage": _usage(),
        }
    )


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe for the docker e2e stack."""
    return {"status": "ok"}
