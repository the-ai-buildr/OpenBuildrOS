"""
API tests against the real OpenBuildrOS app, with the fake OpenRouter behind every model call.

They prove the platform's contract with the web UI: admin agents are served, the Builder
publishes a new agent that then lists and runs like any other, confirmation-gated Studio
operations pause for approval, AG-UI and A2A are exposed, and the API key gate works.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi.testclient import TestClient

ADMIN_IDS = {"platform-builder", "platform-manager", "platform-engineer"}


def sse_events(body: str) -> list[dict[str, Any]]:
    """Parse an SSE body into its ``data:`` JSON payloads, in order."""
    return [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ") and line[6:] != "[DONE]"]


def stream_events(client: TestClient, path: str, data: dict[str, str]) -> list[dict[str, Any]]:
    """POST a streaming form request and return the decoded SSE events."""
    with client.stream("POST", path, data={"stream": "true", "user_id": "admin", **data}) as response:
        assert response.status_code == 200
        return sse_events("".join(response.iter_text()))


def run_stream(client: TestClient, agent_id: str, message: str, **form: str) -> list[dict[str, Any]]:
    """Run an agent with streaming on, as the UI does, and return the decoded events."""
    return stream_events(client, f"/agents/{agent_id}/runs", {"message": message, **form})


def agent_ids(client: TestClient) -> dict[str, bool]:
    """Map every listed agent id to whether it is a runtime-built (Studio) component."""
    response = client.get("/agents")
    assert response.status_code == 200
    return {agent["id"]: bool(agent.get("is_component")) for agent in response.json()}


def test_health(client: TestClient) -> None:
    assert client.get("/health").json()["status"] == "ok"


def test_admin_agents_are_served_with_openrouter_models(client: TestClient) -> None:
    agents = {agent["id"]: agent for agent in client.get("/agents").json()}
    assert ADMIN_IDS <= set(agents)
    for agent_id in ADMIN_IDS:
        assert agents[agent_id]["model"]["provider"] == "OpenRouter"
        assert not agents[agent_id].get("is_component")


def test_registry_exposes_buildable_tools(client: TestClient) -> None:
    names = {item["name"] for item in client.get("/registry").json()["data"]}
    assert {"calculator", "websearch", "extract_json", "extract_urls"} <= names


def test_palette_lists_only_declared_tools(client: TestClient) -> None:
    names = [tool["name"] for tool in client.get("/palette").json()]
    assert names == ["calculator", "websearch", "file_generation", "computer"]


def test_admin_agent_streams_a_reply(client: TestClient) -> None:
    events = run_stream(client, "platform-manager", "status?")
    kinds = [event["event"] for event in events]
    assert kinds[0] == "RunStarted" and kinds[-1] == "RunCompleted"
    text = "".join(event.get("content") or "" for event in events if event["event"] == "RunContent")
    assert "Echo: status?" in text


def test_builder_publishes_an_agent_that_lists_and_runs(client: TestClient) -> None:
    name = f"Haiku Bot {uuid.uuid4().hex[:6]}"
    events = run_stream(client, "platform-builder", f"BUILD: {name}")
    created = [e for e in events if e["event"] == "ToolCallCompleted" and e["tool"]["tool_name"] == "create_agent"]
    assert created, [e["event"] for e in events]
    envelope = json.loads(created[0]["tool"]["result"])
    assert envelope["ok"] is True, envelope
    new_id = envelope["data"]["id"]

    assert agent_ids(client).get(new_id) is True

    # Another user can run the published agent, non-streaming.
    response = client.post(f"/agents/{new_id}/runs", data={"message": "hi", "stream": "false", "user_id": "someone"})
    assert response.status_code == 200
    assert response.json()["content"].strip() == "Echo: hi"


def test_archive_pauses_for_approval_then_completes(client: TestClient) -> None:
    name = f"Temp Bot {uuid.uuid4().hex[:6]}"
    created = run_stream(client, "platform-builder", f"BUILD: {name}")
    result = next(e for e in created if e["event"] == "ToolCallCompleted")["tool"]["result"]
    component_id = json.loads(result)["data"]["id"]

    session_id = str(uuid.uuid4())
    events = run_stream(client, "platform-builder", f"ARCHIVE: {component_id}", session_id=session_id)
    paused = events[-1]
    assert paused["event"] == "RunPaused"
    tools = paused["tools"]
    assert tools[0]["tool_name"] == "archive_component" and tools[0]["requires_confirmation"]
    assert agent_ids(client).get(component_id) is True  # nothing happened yet

    for tool in tools:
        tool["confirmed"] = True
    path = f"/agents/platform-builder/runs/{paused['run_id']}/continue"
    resumed = stream_events(client, path, {"tools": json.dumps(tools), "session_id": session_id})
    assert resumed[-1]["event"] == "RunCompleted"
    assert component_id not in agent_ids(client)


def test_ag_ui_endpoint_streams_protocol_events(client: TestClient) -> None:
    payload = {
        "threadId": str(uuid.uuid4()),
        "runId": str(uuid.uuid4()),
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": "ping"}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    with client.stream("POST", "/ag-ui/platform-manager/agui", json=payload) as response:
        assert response.status_code == 200
        types = [event["type"] for event in sse_events("".join(response.iter_text()))]
    assert types[0] == "RUN_STARTED" and types[-1] == "RUN_FINISHED"
    assert "TEXT_MESSAGE_CONTENT" in types


def test_a2a_agent_card(client: TestClient) -> None:
    response = client.get("/a2a/agents/platform-builder/.well-known/agent-card.json")
    assert response.status_code == 200
    assert response.json()["name"] == "Platform Builder"


def test_security_key_gates_the_api(client: TestClient, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """With OS_SECURITY_KEY set, AgentOS routes and /palette need the matching bearer token."""
    from app.main import api_settings

    monkeypatch.setattr(api_settings, "os_security_key", "s3cret")
    for path in ("/agents", "/palette", "/ag-ui/platform-manager/status"):
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer s3cret"}).status_code == 200
