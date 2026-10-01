"""
Resilient streaming: runs started with ``background=true`` outlive the HTTP stream, so a
client that drops can resume from its last ``event_index`` without losing or repeating
output, and Stop still cancels the detached run.

These tests talk to a real server (``live_server``) because they must disconnect mid-stream.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx

AGENT = "platform-manager"
MESSAGE = "SLOW alpha beta gamma delta epsilon zeta"


def read_events(response: httpx.Response, stop_after: str | None = None) -> list[dict[str, Any]]:
    """Decode SSE ``data:`` events, optionally returning early (a disconnect) after ``stop_after``."""
    events: list[dict[str, Any]] = []
    for line in response.iter_lines():
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))
            if events[-1].get("event") == stop_after:
                break
    return events


def start_and_drop(base_url: str, session_id: str) -> list[dict[str, Any]]:
    """Start a slow background run, read up to its first content token, then drop the connection."""
    data = {"message": MESSAGE, "stream": "true", "background": "true", "user_id": "admin", "session_id": session_id}
    with httpx.stream("POST", f"{base_url}/agents/{AGENT}/runs", data=data, timeout=30) as response:
        assert response.status_code == 200
        return read_events(response, stop_after="RunContent")


def resume(base_url: str, run_id: str, session_id: str, last_index: int) -> list[dict[str, Any]]:
    """Resume a run's stream after ``last_index``; drops the ``replay`` marker event."""
    data = {"last_event_index": str(last_index), "session_id": session_id}
    path = f"{base_url}/agents/{AGENT}/runs/{run_id}/resume"
    with httpx.stream("POST", path, data=data, timeout=30) as response:
        assert response.status_code == 200
        return [event for event in read_events(response) if "event_index" in event]


def content(events: list[dict[str, Any]]) -> str:
    return "".join(event.get("content") or "" for event in events if event["event"] == "RunContent")


def test_dropped_stream_resumes_without_gaps_or_duplicates(live_server: str) -> None:
    session_id = str(uuid.uuid4())
    before = start_and_drop(live_server, session_id)
    assert before[-1]["event"] == "RunContent"
    last_index = before[-1]["event_index"]

    after = resume(live_server, before[0]["run_id"], session_id, last_index)

    indices = [event["event_index"] for event in after]
    assert indices == list(range(last_index + 1, last_index + 1 + len(indices)))
    assert after[-1]["event"] == "RunCompleted"
    assert content(before + after).strip() == f"Echo: {MESSAGE}"


def test_stop_cancels_a_detached_run(live_server: str) -> None:
    session_id = str(uuid.uuid4())
    before = start_and_drop(live_server, session_id)
    run_id = before[0]["run_id"]

    response = httpx.post(f"{live_server}/agents/{AGENT}/runs/{run_id}/cancel", timeout=10)
    assert response.status_code == 200, response.text

    after = resume(live_server, run_id, session_id, before[-1]["event_index"])
    # Agno closes a cancelled run with RunCancelled followed by a final RunCompleted.
    assert "RunCancelled" in [event["event"] for event in after]
    assert content(before + after).strip() != f"Echo: {MESSAGE}"
