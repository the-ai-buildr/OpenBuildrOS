"""Tests for the computer service against a real headless Chromium."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-computer-token"


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    os.environ["COMPUTER_TOKEN"] = TOKEN
    os.environ["WORKSPACE_ROOT"] = str(tmp_path_factory.mktemp("workspaces"))
    import computer

    computer.COMPUTER_TOKEN = TOKEN
    computer.WORKSPACE_ROOT = Path(os.environ["WORKSPACE_ROOT"])
    with TestClient(computer.app, headers={"Authorization": f"Bearer {TOKEN}"}) as test_client:
        yield test_client


PAGE = (
    "data:text/html,<title>Form</title><label>Name <input id=n></label><p id=out>hello</p>"
    "<button onclick=\"out.textContent='clicked '+n.value\">Finish</button>"
)


def test_health_is_open_and_everything_else_needs_the_token(client: TestClient) -> None:
    assert client.get("/health", headers={"Authorization": ""}).status_code == 200
    assert client.get("/bots/a/files", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_browser_navigate_type_click_and_screenshot(client: TestClient) -> None:
    page = client.post("/bots/alpha/browser/navigate", json={"url": PAGE}).json()
    assert page["title"] == "Form" and "hello" in page["text"]
    assert client.post("/bots/alpha/browser/type", json={"target": "Name", "text": "Ada"}).status_code == 200
    after = client.post("/bots/alpha/browser/click", json={"target": "Finish"}).json()
    assert "clicked Ada" in after["text"]
    shot = client.get("/bots/alpha/browser/screenshot")
    assert shot.headers["content-type"] == "image/png" and shot.content[:4] == b"\x89PNG"


def test_shell_runs_in_the_bots_workspace_with_a_clean_environment(client: TestClient) -> None:
    os.environ["SECRET_SHOULD_NOT_LEAK"] = "x"
    result = client.post("/bots/alpha/shell", json={"command": "echo hi > note.txt; pwd; env"}).json()
    assert result["exit_code"] == 0
    assert result["stdout"].splitlines()[0].endswith("/alpha")
    assert "SECRET_SHOULD_NOT_LEAK" not in result["stdout"]
    files = client.get("/bots/alpha/files").json()["entries"]
    assert {"name": "note.txt", "type": "file", "size": 3} in files


def test_shell_timeout(client: TestClient) -> None:
    result = client.post("/bots/alpha/shell", json={"command": "sleep 5", "timeout": 1}).json()
    assert result["timed_out"] is True


def test_files_are_per_bot_and_cannot_escape(client: TestClient) -> None:
    client.post("/bots/alpha/files/write", json={"path": "a/b.txt", "content": "data"})
    assert client.get("/bots/alpha/files/read", params={"path": "a/b.txt"}).json()["content"] == "data"
    assert client.get("/bots/beta/files/read", params={"path": "a/b.txt"}).status_code == 404
    assert client.get("/bots/alpha/files/read", params={"path": "../beta/x"}).status_code == 400
    assert client.post("/bots/alpha/files/write", json={"path": "../../etc/x", "content": "x"}).status_code == 400
    assert client.get("/bots/..%2Fetc/files").status_code in (400, 404)


def test_reset_wipes_the_workspace(client: TestClient) -> None:
    client.post("/bots/gamma/files/write", json={"path": "keep.txt", "content": "x"})
    assert client.post("/bots/gamma/reset").status_code == 200
    assert client.get("/bots/gamma/files/read", params={"path": "keep.txt"}).status_code == 404
