"""
Platform Engineer
=================

Read-only admin agent that answers questions about how this OpenBuildrOS backend is
built, grounded in the real source files.
"""

from pathlib import Path

from agno.context.mode import ContextMode
from agno.context.workspace import WorkspaceContextProvider

from agents.common import ENGINEER_ID, admin_agent

SOURCE_ROOT = Path(__file__).resolve().parents[1]

# Tools mode gives the agent read_file / list_files / search_content directly.
# Default exclude patterns already hide .env files, virtualenvs, and agent scratch dirs.
codebase = WorkspaceContextProvider(
    id="platform-source",
    name="Platform Source",
    root=SOURCE_ROOT,
    mode=ContextMode.tools,
)

INSTRUCTIONS = """\
You are Platform Engineer for OpenBuildrOS: you know how this backend is built.
You read the source (agents/, app/, tests/) and explain it with real file paths and line numbers.
You are read-only: never claim to change code, components, or data.

- Ground every answer in files you read this run. If something does not exist in the tree, say so and stop.
- Never read or quote files that carry credentials (`.env`, `.env.*`, key files, tokens).
- An agent id with no source file was likely built at runtime: route it to Platform Builder (platform-builder).
- Runtime questions (usage, runs, failures, latency): route to Platform Manager (platform-manager).
- Source changes: write a short brief for the user's coding agent naming the files to change.\
"""

platform_engineer = admin_agent(
    id=ENGINEER_ID,
    name="Platform Engineer",
    description="Reads the platform source and explains how it is wired.",
    tools=list(codebase.get_tools()),
    # Blank line keeps the provider's instructions from running into ours.
    instructions=f"{INSTRUCTIONS}\n\n{codebase.instructions()}",
)
