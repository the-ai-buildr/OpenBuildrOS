"""
OpenBuildrOS AgentOS Entrypoint
===============================

Builds the FastAPI app that serves:

- the AgentOS REST API (``/agents``, ``/agents/{id}/runs``, ``/sessions``, ``/components`` ...)
  used by the OpenBuildrOS web UI and os.agno.com;
- the admin agents Platform Builder, Platform Manager, and Platform Engineer, plus
  every agent published at runtime through Studio;
- AG-UI endpoints for each admin agent at ``POST /ag-ui/{agent_id}/agui``;
- an A2A server for every agent under ``/a2a``;
- ``GET /palette``: the tools Platform Builder may wire into new agents.

Run locally with ``uvicorn app.main:app --reload``.
"""

from agno.os import AgentOS
from agno.os.auth import get_authentication_dependency
from agno.os.interfaces.agui import AGUI
from agno.os.settings import AgnoAPISettings
from agno.tools import Toolkit
from fastapi import Depends, FastAPI

from agents.builder import platform_builder
from agents.engineer import platform_engineer
from agents.manager import platform_manager
from app.db import get_db
from app.registry import registry
from app.settings import PRODUCT_NAME, get_settings

settings = get_settings()
settings.validate()

# Defined in code, always served, and never editable from Studio.
ADMIN_AGENTS: list = [platform_builder, platform_manager, platform_engineer]

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


agent_os = AgentOS(
    id="openbuildros",
    name=PRODUCT_NAME,
    description="Open source agent builder platform on Agno AgentOS.",
    db=get_db(),
    agents=ADMIN_AGENTS,
    registry=registry,
    interfaces=[AGUI(agent=agent, prefix=f"/ag-ui/{agent.id}") for agent in ADMIN_AGENTS],
    a2a_interface=True,
    tracing=True,
    telemetry=False,
    settings=api_settings,
    base_app=base_app,
)
app = agent_os.get_app()


if __name__ == "__main__":
    agent_os.serve(app="app.main:app", reload=settings.is_dev)
