"""
OpenBuildrOS Computer Supervisor
================================

Starts one computer container per bot, on demand, and stops it when idle.

It is the only component holding the Docker socket, and it only ever creates
containers from ``COMPUTER_IMAGE``, with fixed resource limits, on the
``COMPUTER_NETWORK`` network (which does not reach the database). Each bot gets a
named workspace volume, so its files and browser logins survive restarts.

API (all routes but ``/health`` need ``Authorization: Bearer $SUPERVISOR_TOKEN``):

- ``POST /computers/{bot_id}``: ensure the bot's computer is running; returns its URL.
- ``GET /computers/{bot_id}``: its URL if running, else 404 (never starts one).
- ``GET /computers``: every bot computer and its state.
- ``DELETE /computers/{bot_id}?wipe=true``: stop it; ``wipe`` also deletes its workspace.
"""

import asyncio
import hmac
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Annotated, Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException

BOT_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,100}$")
PORT = 8080
LABEL = "openbuildr.bot"


@dataclass
class Config:
    """Supervisor settings, read from the environment."""

    token: str = field(default_factory=lambda: os.getenv("SUPERVISOR_TOKEN", ""))
    image: str = field(default_factory=lambda: os.getenv("COMPUTER_IMAGE", "openbuildros-computer:latest"))
    network: str = field(default_factory=lambda: os.getenv("COMPUTER_NETWORK", "openbuildros-computers"))
    computer_token: str = field(default_factory=lambda: os.getenv("COMPUTER_TOKEN", ""))
    prefix: str = field(default_factory=lambda: os.getenv("CONTAINER_PREFIX", "obr-computer-"))
    memory: str = field(default_factory=lambda: os.getenv("COMPUTER_MEMORY", "2g"))
    cpus: float = field(default_factory=lambda: float(os.getenv("COMPUTER_CPUS", "1")))
    # e.g. "runsc" for gVisor, where the host has it installed.
    runtime: str | None = field(default_factory=lambda: os.getenv("COMPUTER_RUNTIME") or None)
    idle_seconds: int = field(default_factory=lambda: int(os.getenv("COMPUTER_IDLE_MINUTES", "30")) * 60)
    start_timeout: float = 60.0


# No ``from __future__ import annotations`` here: FastAPI must resolve the dependency
# annotations declared inside ``create_app`` at runtime.


class Supervisor:
    """Creates, finds, and stops bot computer containers through a Docker client."""

    def __init__(self, config: Config, docker_client: Any) -> None:
        self.config = config
        self.docker = docker_client
        self.last_used: dict[str, float] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def name(self, bot_id: str) -> str:
        return f"{self.config.prefix}{bot_id}"

    def url(self, bot_id: str) -> str:
        return f"http://{self.name(bot_id)}:{PORT}"

    def _container(self, bot_id: str) -> Any | None:
        found = self.docker.containers.list(all=True, filters={"name": f"^{self.name(bot_id)}$"})
        return found[0] if found else None

    def running(self, bot_id: str) -> bool:
        container = self._container(bot_id)
        return container is not None and container.status == "running"

    async def ensure(self, bot_id: str) -> str:
        """Start the bot's computer if needed and wait until it answers; returns its URL."""
        lock = self._locks.setdefault(bot_id, asyncio.Lock())
        async with lock:
            container = self._container(bot_id)
            if container is None:
                await asyncio.to_thread(self._create, bot_id)
            elif container.status != "running":
                await asyncio.to_thread(container.start)
            await self._wait_healthy(bot_id)
            self.last_used[bot_id] = time.monotonic()
            return self.url(bot_id)

    def _create(self, bot_id: str) -> None:
        options: dict[str, Any] = {
            "image": self.config.image,
            "name": self.name(bot_id),
            "detach": True,
            "network": self.config.network,
            "environment": {"COMPUTER_TOKEN": self.config.computer_token, "WORKSPACE_ROOT": "/workspace"},
            "volumes": {f"{self.name(bot_id)}-workspace": {"bind": "/workspace", "mode": "rw"}},
            "labels": {LABEL: bot_id},
            "mem_limit": self.config.memory,
            "nano_cpus": int(self.config.cpus * 1_000_000_000),
            "pids_limit": 2048,
            "security_opt": ["no-new-privileges"],
            "cap_drop": ["ALL"],
        }
        if self.config.runtime:
            options["runtime"] = self.config.runtime
        self.docker.containers.run(**options)

    async def _wait_healthy(self, bot_id: str) -> None:
        deadline = time.monotonic() + self.config.start_timeout
        async with httpx.AsyncClient(timeout=3.0) as client:
            while time.monotonic() < deadline:
                try:
                    if (await client.get(f"{self.url(bot_id)}/health")).status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.5)
        raise HTTPException(status_code=504, detail=f"Computer for {bot_id} did not become healthy")

    def stop(self, bot_id: str, wipe: bool = False) -> bool:
        """Stop and remove the bot's container; ``wipe`` also deletes its workspace volume."""
        container = self._container(bot_id)
        if container is not None:
            container.remove(force=True)
        self.last_used.pop(bot_id, None)
        if wipe:
            try:
                self.docker.volumes.get(f"{self.name(bot_id)}-workspace").remove(force=True)
            except Exception:  # noqa: BLE001 - absent volume is fine
                pass
        return container is not None

    def computers(self) -> list[dict[str, Any]]:
        return [
            {"bot_id": c.labels.get(LABEL), "name": c.name, "status": c.status}
            for c in self.docker.containers.list(all=True, filters={"label": LABEL})
        ]

    def reap_idle(self) -> list[str]:
        """Stop computers unused for longer than the idle limit (workspaces are kept)."""
        cutoff = time.monotonic() - self.config.idle_seconds
        idle = [bot for bot, used in self.last_used.items() if used < cutoff]
        for bot in idle:
            self.stop(bot)
        return idle


def create_app(supervisor: Supervisor | None = None) -> FastAPI:
    """Build the API; tests pass a supervisor with a fake Docker client."""
    state: dict[str, Supervisor] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
        if supervisor is not None:
            state["supervisor"] = supervisor
        else:
            import docker

            state["supervisor"] = Supervisor(Config(), docker.from_env())

        async def reaper() -> None:
            while True:
                await asyncio.sleep(60)
                await asyncio.to_thread(state["supervisor"].reap_idle)

        task = asyncio.create_task(reaper())
        try:
            yield
        finally:
            task.cancel()

    app = FastAPI(title="OpenBuildrOS Computer Supervisor", lifespan=lifespan)

    def require_token(authorization: Annotated[str, Header()] = "") -> Supervisor:
        sup = state["supervisor"]
        if not sup.config.token or not hmac.compare_digest(authorization, f"Bearer {sup.config.token}"):
            raise HTTPException(status_code=401, detail="Invalid supervisor token")
        return sup

    Authorized = Annotated[Supervisor, Depends(require_token)]

    def check(bot_id: str) -> None:
        if not BOT_ID.match(bot_id):
            raise HTTPException(status_code=400, detail="Invalid bot id")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/computers/{bot_id}")
    async def ensure(bot_id: str, sup: Authorized) -> dict[str, str]:
        check(bot_id)
        return {"url": await sup.ensure(bot_id)}

    @app.get("/computers/{bot_id}")
    async def get(bot_id: str, sup: Authorized) -> dict[str, str]:
        check(bot_id)
        if not await asyncio.to_thread(sup.running, bot_id):
            raise HTTPException(status_code=404, detail="Computer is not running")
        return {"url": sup.url(bot_id)}

    @app.get("/computers")
    async def list_computers(sup: Authorized) -> list[dict[str, Any]]:
        return await asyncio.to_thread(sup.computers)

    @app.delete("/computers/{bot_id}")
    async def stop(bot_id: str, sup: Authorized, wipe: bool = False) -> dict[str, bool]:
        check(bot_id)
        return {"stopped": await asyncio.to_thread(sup.stop, bot_id, wipe)}

    return app


app = create_app()
