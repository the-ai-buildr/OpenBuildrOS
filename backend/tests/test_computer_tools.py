"""
Per-bot computers through the gateway: every action is decided by policy and audited
before it reaches the bot's own browser, workspace, and shell.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.policy import Action, Policy, is_private_host
from app.settings import Settings
from tests.test_api import run_stream
from tests.test_collab import build


def computer_agent(client: TestClient) -> str:
    envelope = build(client, f"BUILD: Operator {uuid.uuid4().hex[:6]} | computer")
    assert envelope["ok"], envelope
    return str(envelope["data"]["id"])


def tool_result(client: TestClient, agent_id: str, command: str) -> str:
    """Run ``command`` (a fake-model script) on ``agent_id`` and return its tool's result."""
    events = run_stream(client, agent_id, command)
    done = [e for e in events if e["event"] == "ToolCallCompleted"]
    assert done, [e["event"] for e in events]
    return str(done[-1]["tool"]["result"])


def audit_rows(client: TestClient, bot_id: str) -> list[dict[str, Any]]:
    response = client.get("/audit", params={"bot_id": bot_id})
    assert response.status_code == 200
    return list(response.json())


def test_computer_is_buildable(client: TestClient) -> None:
    assert "computer" in [tool["name"] for tool in client.get("/palette").json()]


def test_shell_runs_in_the_bots_own_workspace_and_is_audited(client: TestClient) -> None:
    bot = computer_agent(client)
    result = json.loads(tool_result(client, bot, "SHELL: echo hello > hi.txt && cat hi.txt && pwd"))
    assert result["exit_code"] == 0
    lines = result["stdout"].splitlines()
    assert lines[0] == "hello" and lines[1].endswith(f"/{bot}")
    row = audit_rows(client, bot)[0]
    assert (row["tool"], row["decision"], row["bot_id"]) == ("run_shell", "allowed", bot)
    assert row["user_id"] == "admin" and row["run_id"]


def test_each_bot_has_its_own_files(client: TestClient) -> None:
    first, second = computer_agent(client), computer_agent(client)
    tool_result(client, first, "WRITEFILE: notes/plan.md | secret plan")
    listing = json.loads(tool_result(client, second, "LISTFILES:"))
    assert listing["entries"] == []
    assert "notes" in [entry["name"] for entry in json.loads(tool_result(client, first, "LISTFILES:"))["entries"]]


def test_policy_refuses_before_acting_and_says_why(client: TestClient) -> None:
    bot = computer_agent(client)
    result = tool_result(client, bot, "SHELL: echo forbidden > nope.txt")
    assert result.startswith("Refused by policy (deny")
    row = audit_rows(client, bot)[0]
    assert row["decision"] == "denied" and "forbidden" in row["rule"]
    assert json.loads(tool_result(client, bot, "LISTFILES:"))["entries"] == []


def test_private_network_browsing_is_refused(client: TestClient) -> None:
    bot = computer_agent(client)
    result = tool_result(client, bot, "BROWSE: http://127.0.0.1:9/admin")
    assert "private network address" in result
    assert audit_rows(client, bot)[0]["decision"] == "denied"


def test_browse_and_live_screen(client: TestClient) -> None:
    bot = computer_agent(client)
    result = tool_result(client, bot, "BROWSE: data:text/html,<title>Hello</title><p>visible text</p>")
    assert "Title: Hello" in result and "visible text" in result
    screen = client.get(f"/computers/{bot}/screen")
    assert screen.status_code == 200 and screen.content[:4] == b"\x89PNG"


class TestPolicy:
    def test_default_allows_everything_but_private_hosts(self) -> None:
        policy = Policy.from_json(None)
        assert policy.decide(Action("run_shell", "bot", "ls")).allowed
        assert not policy.decide(Action("browse", "bot", "http://localhost:3000")).allowed
        assert not policy.decide(Action("browse", "bot", "http://169.254.169.254/latest")).allowed

    def test_deny_wins_and_rules_match_tool_bot_host_and_pattern(self) -> None:
        policy = Policy.from_json(
            json.dumps(
                {
                    "deny": [{"tool": "browse", "host": "*.bank.example"}, {"bot": "intern-*", "tool": "run_shell"}],
                    "allow": [{"tool": "*"}],
                }
            )
        )
        assert not policy.decide(Action("browse", "a", "https://www.bank.example/login")).allowed
        assert policy.decide(Action("browse", "a", "data:text/html,x")).allowed
        assert not policy.decide(Action("run_shell", "intern-7", "ls")).allowed
        assert policy.decide(Action("run_shell", "senior", "ls")).allowed

    def test_empty_allow_list_permits_nothing(self) -> None:
        assert not Policy.from_json('{"deny": [], "allow": []}').decide(Action("read_page", "b")).allowed

    @pytest.mark.parametrize(
        "bad",
        ["not json", '{"deny": [{"tool": "x", "colour": "red"}]}', '{"allow": [{"pattern": "("}]}', '{"other": 1}'],
    )
    def test_malformed_policy_stops_startup(self, bad: str) -> None:
        with pytest.raises(RuntimeError, match="COMPUTER_POLICY"):
            Settings(runtime_env="dev", computer_policy=bad).validate()

    def test_private_host_detection(self) -> None:
        assert is_private_host("localhost") and is_private_host("10.1.2.3") and is_private_host("db.internal")
        assert not is_private_host("") and not is_private_host("8.8.8.8")


def test_computer_settings_are_validated() -> None:
    with pytest.raises(RuntimeError, match="COMPUTER_MODE"):
        Settings(runtime_env="dev", computer_mode="sometimes").validate()
    secrets = {"openrouter_api_key": "k", "os_security_key": "s"}
    with pytest.raises(RuntimeError, match="COMPUTER_TOKEN"):
        Settings(runtime_env="prd", computer_mode="shared", **secrets).validate()  # type: ignore[arg-type]
    with pytest.raises(RuntimeError, match="SUPERVISOR_TOKEN"):
        Settings(runtime_env="prd", computer_mode="per-bot", computer_token="c", **secrets).validate()  # type: ignore[arg-type]
