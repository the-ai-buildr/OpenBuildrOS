"""
Admin Agent Defaults
====================

Shared construction for the code-defined admin agents.
"""

from typing import Any

from agno.agent import Agent

from app.db import get_db
from app.settings import build_model

# Identity fallback for runs that carry no user_id (the UI proxy always sends one).
DEFAULT_USER_ID = "admin"


def admin_agent(**kwargs: Any) -> Agent:
    """Build an admin agent with the platform's shared defaults.

    Every admin agent gets its own OpenRouter model instance, the shared database,
    the last five runs of history, the current datetime, and markdown output.
    Keyword arguments (``id``, ``name``, ``tools``, ``instructions`` ...) are passed
    to :class:`agno.agent.Agent` and override any default.

    Returns:
        The configured agent.
    """
    defaults: dict[str, Any] = {
        "model": build_model(),
        "db": get_db(),
        "user_id": DEFAULT_USER_ID,
        "add_datetime_to_context": True,
        "add_history_to_context": True,
        "num_history_runs": 5,
        "markdown": True,
    }
    return Agent(**{**defaults, **kwargs})
