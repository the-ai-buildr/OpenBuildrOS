"""
AG-UI for Every Agent and Team
==============================

Agno's ``AGUI`` interface serves one agent fixed at startup. Agents and teams built
in Studio appear at runtime, so this router resolves the target per request, the
same way the REST run routes do (admin agents from code, everything else from the
database), and then hands the run to Agno's AG-UI translation:

- ``POST /ag-ui/{agent_id}/agui``: run an agent (admin or Studio-built);
- ``POST /ag-ui/teams/{team_id}/agui``: run a team;
- ``GET /ag-ui/{agent_id}/status`` and ``GET /ag-ui/teams/{team_id}/status``.

Any AG-UI client (CopilotKit, OpenBot, ...) can point at these with the
``OS_SECURITY_KEY`` bearer token. Identity and session ownership are enforced
exactly as in Agno's own interface.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from agno.os.interfaces.agui.router import run_entity
from agno.os.middleware.user_scope import assert_session_writable, caller_is_admin, resolve_run_user_id
from agno.os.utils import resolve_agent, resolve_team
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

Resolver = Callable[[str, Request, str | None, str | None], Awaitable[Any]]


def agui_router(agent_os: Callable[[], Any]) -> APIRouter:
    """Build the router.

    Args:
        agent_os: Returns the running ``AgentOS``; called per request because the
            router is mounted before the AgentOS object exists.
    """
    router = APIRouter(prefix="/ag-ui", tags=["AGUI"])
    encoder = EventEncoder()

    async def agent(entity_id: str, request: Request, user_id: str | None, session_id: str | None) -> Any:
        os = agent_os()
        return await resolve_agent(
            entity_id, os.agents, os.db, os.registry, request=request, user_id=user_id, session_id=session_id
        )

    async def team(entity_id: str, request: Request, user_id: str | None, session_id: str | None) -> Any:
        os = agent_os()
        return await resolve_team(
            entity_id, os.teams, os.db, os.registry, request=request, user_id=user_id, session_id=session_id
        )

    async def run(resolve: Resolver, entity_id: str, request: Request, run_input: RunAgentInput) -> StreamingResponse:
        client_user_id = (run_input.forwarded_props or {}).get("user_id")
        user_id = resolve_run_user_id(request, client_user_id)
        entity = await resolve(entity_id, request, user_id, run_input.thread_id)
        # The thread id is client-supplied: refuse another user's session before streaming.
        await assert_session_writable(
            getattr(entity, "db", None),
            run_input.thread_id,
            user_id or getattr(entity, "user_id", None),
            is_admin=caller_is_admin(request),
        )

        async def events():  # type: ignore[no-untyped-def]
            async for event in run_entity(entity, run_input, user_id=user_id):
                yield encoder.encode(event)

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @router.post("/teams/{team_id}/agui")
    async def run_team(team_id: str, request: Request, run_input: RunAgentInput) -> StreamingResponse:
        """Run a team and stream AG-UI events."""
        return await run(team, team_id, request, run_input)

    @router.get("/teams/{team_id}/status")
    async def team_status(team_id: str, request: Request) -> dict[str, str]:
        """``available`` when the team exists (404 otherwise)."""
        await team(team_id, request, None, None)
        return {"status": "available"}

    @router.post("/{agent_id}/agui")
    async def run_agent(agent_id: str, request: Request, run_input: RunAgentInput) -> StreamingResponse:
        """Run an agent and stream AG-UI events."""
        return await run(agent, agent_id, request, run_input)

    @router.get("/{agent_id}/status")
    async def agent_status(agent_id: str, request: Request) -> dict[str, str]:
        """``available`` when the agent exists (404 otherwise)."""
        await agent(agent_id, request, None, None)
        return {"status": "available"}

    return router
