"""
OpenBuildrOS AgentOS Entrypoint
===============================

Builds the FastAPI app that serves:

- the AgentOS REST API (``/agents``, ``/agents/{id}/runs``, ``/sessions``, ``/components`` ...)
  used by the OpenBuildrOS web UI and os.agno.com;
- the admin agents Platform Builder, Platform Manager, and Platform Engineer, plus
  every agent published at runtime through Studio;
- AG-UI endpoints for every agent and team, Studio-built ones included
  (``POST /ag-ui/{agent_id}/agui``, ``POST /ag-ui/teams/{team_id}/agui``; see ``app/agui.py``);
- an A2A server for every agent under ``/a2a``;
- ``GET /palette``: the tools Platform Builder may wire into new agents;
- the scheduler, which fires Studio-created schedules against this API.

Runs started with ``background=true`` survive client disconnects; their events
carry an ``event_index`` and can be replayed with
``POST /agents/{id}/runs/{run_id}/resume``, and ``/cancel`` stops them. The replay
buffer and the cancellation registry are in memory by default and in Redis when
``REDIS_URL`` is set (required for several workers).

Run locally with ``uvicorn app.main:app --reload``.
"""

from agno.os import AgentOS
from agno.os.auth import get_authentication_dependency
from agno.os.event_streams import BaseEventStream
from agno.os.settings import AgnoAPISettings
from agno.tools import Toolkit
from fastapi import Depends, FastAPI, HTTPException, Response

from agents.builder import platform_builder
from agents.engineer import platform_engineer
from agents.manager import platform_manager
from app import audit
from app.agui import agui_router
from app.computer import ComputerError, call_computer
from app.db import get_db
from app.registry import registry
from app.settings import PRODUCT_NAME, get_settings

settings = get_settings()
settings.validate()

# Defined in code, always served, and never editable from Studio.
ADMIN_AGENTS: list = [platform_builder, platform_manager, platform_engineer]


def use_redis(redis_url: str | None) -> BaseEventStream | None:
    """Share run state across workers through Redis when ``redis_url`` is set.

    Two pieces must be shared, or a request landing on another worker cannot find
    the run: the event buffer that ``/resume`` replays from, and the cancellation
    registry that ``/cancel`` writes to (installed globally here).

    Args:
        redis_url: ``redis://...``, or ``None`` to keep AgentOS's in-memory defaults.

    Returns:
        The Redis-backed event stream for AgentOS, or ``None``.
    """
    if not redis_url:
        return None
    from agno.os.event_streams.redis import RedisEventStream
    from agno.run.cancel import set_cancellation_manager
    from agno.run.cancellation_management.redis_cancellation_manager import RedisRunCancellationManager
    from redis import Redis
    from redis.asyncio import Redis as AsyncRedis

    set_cancellation_manager(
        RedisRunCancellationManager(
            redis_client=Redis.from_url(redis_url), async_redis_client=AsyncRedis.from_url(redis_url)
        )
    )
    return RedisEventStream(AsyncRedis.from_url(redis_url))


api_settings = AgnoAPISettings(
    env=settings.runtime_env,
    os_security_key=settings.os_security_key,
    cors_origin_list=settings.cors_origins,
    docs_enabled=settings.is_dev,
)

# Extra routes merged into the AgentOS app; same bearer-key auth as AgentOS.
base_app = FastAPI()


@base_app.get("/palette", dependencies=[Depends(get_authentication_dependency(api_settings))])
def palette() -> list[dict[str, str]]:
    """List the tools new agents may use: those declared in ``app/registry.py``.

    The registry also holds tools discovered on the admin agents (Studio, AgentOS,
    workspace); Studio refuses to build with those, so they are left out here too.

    Returns:
        ``[{"name": ..., "description": ...}]`` in registry order.
    """
    tools = []
    for tool in registry.tools:
        name = tool.name if isinstance(tool, Toolkit) else getattr(tool, "__name__", "")
        if name and registry.tool_is_declared(name):
            doc = (type(tool).__doc__ if isinstance(tool, Toolkit) else tool.__doc__) or ""
            tools.append({"name": name, "description": doc.strip().split("\n")[0]})
    return tools


@base_app.get("/computers/{bot_id}/screen", dependencies=[Depends(get_authentication_dependency(api_settings))])
def computer_screen(bot_id: str) -> Response:
    """A PNG of the bot's screen for the UI's live view. Never starts a stopped computer.

    Raises:
        HTTPException: 404 when computers are off or this bot's computer is not running.
    """
    if settings.computer_mode == "off":
        raise HTTPException(status_code=404, detail="Computers are off in this deployment")
    try:
        png = call_computer(bot_id, "GET", "/browser/screenshot", start=False).content
    except ComputerError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(content=png, media_type="image/png", headers={"cache-control": "no-store"})


@base_app.get("/audit", dependencies=[Depends(get_authentication_dependency(api_settings))])
def audit_log(bot_id: str | None = None, limit: int = 50) -> list[dict]:
    """The newest computer actions: what was allowed, refused (with the rule), and what failed."""
    return audit.recent(bot_id=bot_id, limit=limit)


# Resolved per request, so agents and teams built in Studio are served too.
base_app.include_router(
    agui_router(lambda: agent_os), dependencies=[Depends(get_authentication_dependency(api_settings))]
)

agent_os: AgentOS = AgentOS(
    id="openbuildros",
    name=PRODUCT_NAME,
    description="Open source agent builder platform on Agno AgentOS.",
    db=get_db(),
    agents=ADMIN_AGENTS,
    registry=registry,
    a2a_interface=True,
    scheduler=True,
    scheduler_base_url=settings.agentos_url,
    tracing=True,
    telemetry=False,
    settings=api_settings,
    base_app=base_app,
    event_stream=use_redis(settings.redis_url),
)
app = agent_os.get_app()


if __name__ == "__main__":
    agent_os.serve(app="app.main:app", reload=settings.is_dev)
