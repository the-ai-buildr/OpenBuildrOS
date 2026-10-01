"""
Collaboration: Platform Builder composes user-built agents into teams, workflows, and
schedules; the admin agents can never be pulled into one.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi.testclient import TestClient

from tests.test_api import run_stream


def build(client: TestClient, command: str) -> dict[str, Any]:
    """Ask the Builder for one Studio call and return that tool's JSON envelope."""
    events = run_stream(client, "platform-builder", command)
    done = [e for e in events if e["event"] == "ToolCallCompleted"]
    assert done, [e["event"] for e in events]
    return json.loads(done[-1]["tool"]["result"])


def new_agent(client: TestClient, prefix: str) -> str:
    envelope = build(client, f"BUILD: {prefix} {uuid.uuid4().hex[:6]}")
    assert envelope["ok"], envelope
    return str(envelope["data"]["id"])


def ids(client: TestClient, kind: str) -> set[str]:
    response = client.get(f"/{kind}")
    assert response.status_code == 200, response.text
    return {item["id"] for item in response.json()}


def test_team_of_built_agents_runs_and_delegates(client: TestClient) -> None:
    writer, critic = new_agent(client, "Writer"), new_agent(client, "Critic")
    envelope = build(client, f"TEAM: Desk {uuid.uuid4().hex[:6]} | {writer}, {critic}")
    assert envelope["ok"], envelope
    team_id = envelope["data"]["id"]
    assert team_id in ids(client, "teams")

    data = {"message": f"ASK {writer}: draft a haiku", "stream": "true", "user_id": "admin"}
    with client.stream("POST", f"/teams/{team_id}/runs", data=data) as response:
        assert response.status_code == 200
        events = [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]
    kinds = [event["event"] for event in events]
    assert kinds[0] == "TeamRunStarted" and kinds[-1] == "TeamRunCompleted"
    # The member ran as its own run inside the team's stream.
    member_runs = [e for e in events if e["event"] == "RunCompleted" and e.get("agent_id") == writer]
    assert member_runs and "Echo: draft a haiku" in member_runs[0]["content"]


def test_admin_agents_are_never_team_members(client: TestClient) -> None:
    for admin in ("platform-manager", "platform-engineer", "platform-builder"):
        envelope = build(client, f"TEAM: Sneaky {uuid.uuid4().hex[:6]} | {admin}")
        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "tool_not_allowed", envelope


def test_admin_agents_are_never_workflow_steps(client: TestClient) -> None:
    envelope = build(client, f"FLOW: Sneaky {uuid.uuid4().hex[:6]} | platform-manager")
    assert envelope["ok"] is False
    assert envelope["error"]["code"] == "tool_not_allowed", envelope


def test_workflow_of_built_agents_runs_steps_in_order(client: TestClient) -> None:
    first, second = new_agent(client, "Researcher"), new_agent(client, "Editor")
    envelope = build(client, f"FLOW: Pipeline {uuid.uuid4().hex[:6]} | {first}, {second}")
    assert envelope["ok"], envelope
    workflow_id = envelope["data"]["id"]
    assert workflow_id in ids(client, "workflows")

    response = client.post(
        f"/workflows/{workflow_id}/runs", data={"message": "topic: tides", "stream": "false", "user_id": "admin"}
    )
    assert response.status_code == 200, response.text
    # Step two echoes step one's output, which echoed the input.
    assert "Echo: " in response.json()["content"] and "tides" in response.json()["content"]


def test_builder_schedules_a_built_agent(client: TestClient) -> None:
    agent_id = new_agent(client, "Digest")
    envelope = build(client, f"SCHEDULE: agent {agent_id} | 0 9 * * *")
    assert envelope["ok"], envelope
    schedules = client.get("/schedules").json()
    rows = schedules.get("data", schedules) if isinstance(schedules, dict) else schedules
    assert any(row.get("cron_expr", row.get("cron")) == "0 9 * * *" for row in rows), rows


def ag_ui(client: TestClient, path: str, text: str, thread_id: str | None = None) -> list[dict[str, Any]]:
    """POST one AG-UI run and return its events."""
    from tests.test_api import sse_events

    payload = {
        "threadId": thread_id or str(uuid.uuid4()),
        "runId": str(uuid.uuid4()),
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": text}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    with client.stream("POST", path, json=payload) as response:
        assert response.status_code == 200, response.read()
        return sse_events("".join(response.iter_text()))


def test_ag_ui_serves_studio_built_agents_and_teams(client: TestClient) -> None:
    """Agents and teams created at runtime are reachable over AG-UI without a restart."""
    writer = new_agent(client, "Scribe")
    events = ag_ui(client, f"/ag-ui/{writer}/agui", "hello there")
    types = [event["type"] for event in events]
    assert types[0] == "RUN_STARTED" and types[-1] == "RUN_FINISHED"
    assert "Echo: hello there" in "".join(e.get("delta", "") for e in events)
    assert client.get(f"/ag-ui/{writer}/status").json() == {"status": "available"}

    envelope = build(client, f"TEAM: Room {uuid.uuid4().hex[:6]} | {writer}")
    team_id = envelope["data"]["id"]
    types = [event["type"] for event in ag_ui(client, f"/ag-ui/teams/{team_id}/agui", f"ASK {writer}: hi")]
    assert types[0] == "RUN_STARTED" and types[-1] == "RUN_FINISHED"
    assert client.get(f"/ag-ui/teams/{team_id}/status").json() == {"status": "available"}


def test_ag_ui_unknown_agent_is_404(client: TestClient) -> None:
    assert client.get("/ag-ui/no-such-agent/status").status_code == 404
    assert client.get("/ag-ui/teams/no-such-team/status").status_code == 404
