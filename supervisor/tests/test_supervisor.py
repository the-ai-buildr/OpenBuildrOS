"""Supervisor behavior against a fake Docker client (no daemon needed)."""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

import supervisor as sup_module
from supervisor import Config, Supervisor, create_app


class FakeContainers:
    def __init__(self) -> None:
        self.items: dict[str, SimpleNamespace] = {}
        self.run_calls: list[dict[str, Any]] = []

    def list(self, all: bool = False, filters: dict[str, str] | None = None) -> list[SimpleNamespace]:
        filters = filters or {}
        if "name" in filters:
            name = filters["name"].strip("^$")
            return [c for n, c in self.items.items() if n == name]
        return list(self.items.values())

    def run(self, **options: Any) -> None:
        self.run_calls.append(options)
        name = options["name"]
        self.items[name] = SimpleNamespace(
            name=name,
            status="running",
            labels=options["labels"],
            start=lambda: None,
            remove=lambda force=False: self.items.pop(name, None),
        )


class FakeDocker:
    def __init__(self) -> None:
        self.containers = FakeContainers()
        self.removed_volumes: list[str] = []
        self.volumes = SimpleNamespace(
            get=lambda name: SimpleNamespace(remove=lambda force=False: self.removed_volumes.append(name))
        )


@pytest.fixture
def setup(monkeypatch: pytest.MonkeyPatch) -> tuple[TestClient, FakeDocker, Supervisor]:
    async def healthy(self: Supervisor, bot_id: str) -> None:
        return None

    monkeypatch.setattr(Supervisor, "_wait_healthy", healthy)
    docker = FakeDocker()
    config = Config(token="sup", computer_token="comp", runtime="runsc")
    supervisor = Supervisor(config, docker)
    client = TestClient(create_app(supervisor), headers={"Authorization": "Bearer sup"})
    client.__enter__()
    return client, docker, supervisor


def test_token_is_required(setup: tuple[TestClient, FakeDocker, Supervisor]) -> None:
    client, _, _ = setup
    assert client.get("/health", headers={"Authorization": ""}).status_code == 200
    assert client.post("/computers/a", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_ensure_creates_one_locked_down_container_per_bot(setup: tuple[TestClient, FakeDocker, Supervisor]) -> None:
    client, docker, _ = setup
    assert client.get("/computers/alpha").status_code == 404
    assert client.post("/computers/alpha").json() == {"url": "http://obr-computer-alpha:8080"}
    assert client.post("/computers/alpha").status_code == 200  # idempotent
    assert len(docker.containers.run_calls) == 1
    options = docker.containers.run_calls[0]
    assert options["environment"]["COMPUTER_TOKEN"] == "comp"
    assert options["volumes"] == {"obr-computer-alpha-workspace": {"bind": "/workspace", "mode": "rw"}}
    assert options["cap_drop"] == ["ALL"] and options["runtime"] == "runsc"
    assert client.get("/computers/alpha").json()["url"].endswith(":8080")
    assert client.get("/computers").json() == [{"bot_id": "alpha", "name": "obr-computer-alpha", "status": "running"}]


def test_invalid_bot_ids_are_refused(setup: tuple[TestClient, FakeDocker, Supervisor]) -> None:
    client, _, _ = setup
    assert client.post("/computers/Bad Name").status_code == 400
    assert client.post("/computers/..").status_code in (400, 404)


def test_stop_and_wipe(setup: tuple[TestClient, FakeDocker, Supervisor]) -> None:
    client, docker, _ = setup
    client.post("/computers/beta")
    assert client.delete("/computers/beta", params={"wipe": "true"}).json() == {"stopped": True}
    assert docker.removed_volumes == ["obr-computer-beta-workspace"]
    assert client.get("/computers/beta").status_code == 404


def test_idle_computers_are_reaped(setup: tuple[TestClient, FakeDocker, Supervisor]) -> None:
    client, _, supervisor = setup
    client.post("/computers/gamma")
    supervisor.last_used["gamma"] = time.monotonic() - supervisor.config.idle_seconds - 1
    assert supervisor.reap_idle() == ["gamma"]
    assert client.get("/computers/gamma").status_code == 404


def test_module_builds_the_default_app() -> None:
    assert sup_module.app.title == "OpenBuildrOS Computer Supervisor"
