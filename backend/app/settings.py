"""
Settings
========

Runtime configuration for the OpenBuildrOS backend, read once from the environment.

Every knob lives here so the rest of the code never calls ``os.getenv`` directly:
agents, the registry, and the AgentOS entrypoint all depend on :func:`get_settings`
and :func:`build_model`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import cache
from os import getenv

from agno.models.openrouter import OpenRouter

# Agno agents report usage to Agno unless told otherwise; this covers Studio-built agents
# too. Set AGNO_TELEMETRY=true explicitly to opt back in.
os.environ.setdefault("AGNO_TELEMETRY", "false")

PRODUCT_NAME = "OpenBuildrOS"
DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4.5"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_DATABASE_URL = "sqlite:///tmp/openbuildr.db"
DEFAULT_MAX_TOKENS = 4096


def _split_csv(value: str | None) -> list[str]:
    """Split a comma-separated env value into a list of trimmed, non-empty items.

    Args:
        value: Raw env value such as ``"http://a.com, http://b.com"``; ``None`` is allowed.

    Returns:
        The non-empty items in order.
    """
    return [item.strip() for item in (value or "").split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of the backend configuration.

    Attributes:
        runtime_env: ``"dev"`` relaxes the production guards; anything else is production.
        openrouter_api_key: Key for OpenRouter. Required in production.
        openrouter_base_url: OpenAI-compatible endpoint. Override only for tests or a proxy.
        model_id: Default OpenRouter model id (``provider/model``) for every agent.
        max_tokens: Completion token cap per model call.
        database_url: SQLAlchemy URL. ``sqlite:///...`` for local dev, ``postgresql+psycopg://...`` in production.
        os_security_key: Bearer token every AgentOS API call must carry. Required in production.
        cors_origins: Browser origins allowed to call the API directly.
    """

    runtime_env: str = "prd"
    openrouter_api_key: str | None = None
    openrouter_base_url: str = DEFAULT_OPENROUTER_BASE_URL
    model_id: str = DEFAULT_MODEL_ID
    max_tokens: int = DEFAULT_MAX_TOKENS
    database_url: str = DEFAULT_DATABASE_URL
    os_security_key: str | None = None
    cors_origins: list[str] = field(default_factory=list)

    @property
    def is_dev(self) -> bool:
        """True when running with ``RUNTIME_ENV=dev``."""
        return self.runtime_env == "dev"

    @classmethod
    def from_env(cls) -> Settings:
        """Build settings from environment variables, applying defaults for anything unset."""
        return cls(
            runtime_env=getenv("RUNTIME_ENV", "prd").strip().lower(),
            openrouter_api_key=getenv("OPENROUTER_API_KEY") or None,
            openrouter_base_url=getenv("OPENROUTER_BASE_URL") or DEFAULT_OPENROUTER_BASE_URL,
            model_id=getenv("OPENROUTER_MODEL_ID") or DEFAULT_MODEL_ID,
            max_tokens=int(getenv("OPENROUTER_MAX_TOKENS") or DEFAULT_MAX_TOKENS),
            database_url=getenv("DATABASE_URL") or DEFAULT_DATABASE_URL,
            os_security_key=getenv("OS_SECURITY_KEY") or None,
            cors_origins=_split_csv(getenv("CORS_ORIGINS")),
        )

    def validate(self) -> None:
        """Refuse to start a production deployment that is missing a required secret.

        Raises:
            RuntimeError: In production when ``OPENROUTER_API_KEY`` or ``OS_SECURITY_KEY`` is unset.
        """
        if self.is_dev:
            return
        required = {"OPENROUTER_API_KEY": self.openrouter_api_key, "OS_SECURITY_KEY": self.os_security_key}
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise RuntimeError(
                f"{PRODUCT_NAME} refuses to start in production without: {', '.join(missing)}. "
                "Set them in .env, or set RUNTIME_ENV=dev for local development."
            )


@cache
def get_settings() -> Settings:
    """Return the process-wide settings, read from the environment on first call."""
    return Settings.from_env()


def build_model(model_id: str | None = None) -> OpenRouter:
    """Create a fresh OpenRouter chat model.

    A new instance per agent avoids sharing mutable client state between agents.
    OpenRouter speaks the OpenAI chat-completions API, so this is Agno's
    OpenAI-compatible client pointed at ``https://openrouter.ai/api/v1``.

    Args:
        model_id: OpenRouter model id; defaults to ``OPENROUTER_MODEL_ID``.

    Returns:
        A configured :class:`agno.models.openrouter.OpenRouter` model.
    """
    settings = get_settings()
    return OpenRouter(
        id=model_id or settings.model_id,
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        max_tokens=settings.max_tokens,
    )
