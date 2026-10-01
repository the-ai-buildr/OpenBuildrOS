"""
Test fixtures.

The backend reads its settings once at import time, so the environment is pinned
here, before any ``app`` module is imported: a throwaway SQLite database and the
scripted fake OpenRouter (``tests/fake_llm.py``) served on a free local port.
"""

from __future__ import annotations

import os
import socket
import tempfile
import threading
import time
from collections.abc import Iterator

import pytest
import uvicorn


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


FAKE_LLM_PORT = _free_port()
TEST_DB = os.path.join(tempfile.mkdtemp(prefix="openbuildr-test-"), "test.db")

os.environ.update(
    {
        "RUNTIME_ENV": "dev",
        "DATABASE_URL": f"sqlite:///{TEST_DB}",
        "OPENROUTER_API_KEY": "test-key",
        "OPENROUTER_BASE_URL": f"http://127.0.0.1:{FAKE_LLM_PORT}",
        "OPENROUTER_MODEL_ID": "fake/model",
    }
)
os.environ.pop("OS_SECURITY_KEY", None)


@pytest.fixture(scope="session", autouse=True)
def fake_llm() -> Iterator[str]:
    """Serve the fake OpenRouter for the whole session and yield its base URL."""
    from tests.fake_llm import app as fake_app

    server = uvicorn.Server(uvicorn.Config(fake_app, host="127.0.0.1", port=FAKE_LLM_PORT, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("fake LLM did not start")
        time.sleep(0.05)
    yield f"http://127.0.0.1:{FAKE_LLM_PORT}"
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture(scope="session")
def client(fake_llm: str) -> Iterator:
    """A TestClient for the real OpenBuildrOS app."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
