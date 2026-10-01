"""
Platform Manager
================

Read-only admin agent that watches the running platform: usage, tokens, runs,
latency, failures, traces, and the components built at runtime.
"""

import json

from agno.tools.agentos import AgentOSTools

from agents.common import admin_agent
from app.db import get_db
from app.settings import get_settings

MANAGER_ID = "platform-manager"


def get_platform_config() -> str:
    """Report how this deployment is configured, without revealing any secret.

    Returns:
        JSON with the runtime environment, default model, database backend, and
        whether the OpenRouter key and API security key are set.
    """
    settings = get_settings()
    return json.dumps(
        {
            "runtime_env": settings.runtime_env,
            "default_model": settings.model_id,
            "database": settings.database_url.split(":", 1)[0],
            "openrouter_key_configured": bool(settings.openrouter_api_key),
            "api_auth_enabled": bool(settings.os_security_key),
        }
    )


INSTRUCTIONS = """\
You are Platform Manager for OpenBuildrOS: you watch and explain what the platform is doing and recommend what to
do next. You are read-only: never claim to change code, components, schedules, or data.

- Latency in seconds, and say how many runs a number came from.
- list_platform_components covers runtime-built (Studio) components only. The admin agents (platform-builder,
  platform-manager, platform-engineer) are defined in code and never appear there, so an empty list means nothing
  has been built yet.
- get_platform_config reports deployment configuration; use it for "is the platform healthy/configured" questions.
- Hand off: code wiring and source fixes → Platform Engineer (platform-engineer); new, changed, archived, or deleted
  components → Platform Builder (platform-builder).
- A handoff carries only what your tools observed; phrase anything speculative as a conditional to check.\
"""

platform_manager = admin_agent(
    id=MANAGER_ID,
    name="Platform Manager",
    description="Monitors usage, runs, latency, failures, and built components.",
    tools=[AgentOSTools(db=get_db()), get_platform_config],
    instructions=INSTRUCTIONS,
)
