"""
Computer Tools and Gateway
==========================

Gives an agent its own computer (browser, workspace files, shell) through one
gateway that, for every action:

1. decides it against the policy (``app/policy.py``);
2. writes an audit row for the decision (``app/audit.py``);
3. only then calls the bot's computer, and writes a second row if that fails.

Deployment modes (``COMPUTER_MODE``):

- ``off``: no computer toolkit is registered;
- ``shared``: one computer service (``COMPUTER_URL``) keeps bots apart by directory and
  browser context; for local development and tests;
- ``per-bot``: the supervisor (``SUPERVISOR_URL``) starts one container per bot, so a bot's
  shell can only ever reach its own files.
"""

from __future__ import annotations

import json
from functools import cache
from typing import Any

import httpx
from agno.agent import Agent
from agno.run import RunContext
from agno.tools import Toolkit

from app import audit
from app.policy import Action, Policy
from app.settings import get_settings

REQUEST_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


class ComputerError(RuntimeError):
    """The computer (or supervisor) could not be reached or refused the request."""


@cache
def policy() -> Policy:
    """The deployment's computer policy, parsed once (``COMPUTER_POLICY``)."""
    return Policy.from_json(get_settings().computer_policy)


@cache
def _http() -> httpx.Client:
    return httpx.Client(timeout=REQUEST_TIMEOUT)


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def computer_url(bot_id: str, start: bool = True) -> str:
    """Base URL of ``bot_id``'s computer.

    Args:
        bot_id: The agent whose computer it is.
        start: In per-bot mode, start the container if it is not running. With ``False`` a
            stopped computer raises instead (used by the read-only screen view).

    Raises:
        ComputerError: When the supervisor cannot provide the computer.
    """
    settings = get_settings()
    if settings.computer_mode != "per-bot":
        return settings.computer_url.rstrip("/")
    method = "POST" if start else "GET"
    try:
        response = _http().request(
            method, f"{settings.supervisor_url}/computers/{bot_id}", headers=_bearer(settings.supervisor_token or "")
        )
    except httpx.HTTPError as error:
        raise ComputerError(f"Supervisor unreachable: {error}") from error
    if response.status_code != 200:
        raise ComputerError(f"No computer for {bot_id}: {response.text[:300]}")
    return str(response.json()["url"]).rstrip("/")


def call_computer(bot_id: str, method: str, path: str, start: bool = True, **kwargs: Any) -> httpx.Response:
    """Send one request to ``/bots/{bot_id}{path}`` on the bot's computer.

    Raises:
        ComputerError: On a connection failure or a non-2xx answer.
    """
    url = f"{computer_url(bot_id, start)}/bots/{bot_id}{path}"
    try:
        response = _http().request(method, url, headers=_bearer(get_settings().computer_token or ""), **kwargs)
    except httpx.HTTPError as error:
        raise ComputerError(f"Computer unreachable: {error}") from error
    if response.status_code >= 400:
        raise ComputerError(f"Computer refused ({response.status_code}): {response.text[:500]}")
    return response


def _identity(agent: Agent, run_context: RunContext) -> tuple[str, str | None, str | None]:
    """The bot id, user id, and run id behind a tool call (both injected by Agno)."""
    return str(agent.id), run_context.user_id, run_context.run_id


def gated(tool: str, bot_id: str, target: str, run: Any, *, user_id: str | None, run_id: str | None) -> str:
    """Decide, audit, then run ``run()``; returns the result or the refusal as text for the model.

    Args:
        tool: Action name the policy matches on.
        bot_id: The agent acting.
        target: URL, command, or path the policy inspects and the audit row records.
        run: Zero-argument callable performing the action, returning text.
    """
    decision = policy().decide(Action(tool=tool, bot_id=bot_id, target=target))
    audit.record(
        bot_id=bot_id,
        tool=tool,
        target=target,
        decision="allowed" if decision.allowed else "denied",
        rule=decision.rule,
        user_id=user_id,
        run_id=run_id,
    )
    if not decision.allowed:
        return f"Refused by policy ({decision.rule}). Do not retry this action; tell the user it is not permitted."
    try:
        return str(run())
    except ComputerError as error:
        audit.record(
            bot_id=bot_id,
            tool=tool,
            target=target,
            decision="failed",
            detail=str(error),
            user_id=user_id,
            run_id=run_id,
        )
        return f"Error: {error}"


def _page_summary(response: httpx.Response) -> str:
    page = response.json()
    links = "\n".join(f"- {link['text'] or '(no text)'}: {link['href']}" for link in page.get("links", [])[:20])
    return f"URL: {page['url']}\nTitle: {page['title']}\n\n{page['text']}\n\nLinks:\n{links}"


class ComputerTools(Toolkit):
    """The bot's own computer: a browser with persistent logins, a workspace, and a shell.

    Every action is checked against the deployment policy and recorded in the audit log
    before it runs. The calling agent is injected by Agno, so each agent (including each
    member of a team) works on its own computer.
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(
            name="computer",
            tools=[
                self.browse,
                self.read_page,
                self.click,
                self.type_text,
                self.run_shell,
                self.list_files,
                self.read_file,
                self.write_file,
            ],
            **kwargs,
        )

    def browse(self, url: str, agent: Agent, run_context: RunContext) -> str:
        """Open a web page in your own browser and read it.

        Args:
            url: Full http(s) URL to open.

        Returns:
            The page URL, title, visible text, and links.
        """
        bot_id, user_id, run_id = _identity(agent, run_context)
        return gated(
            "browse",
            bot_id,
            url,
            lambda: _page_summary(call_computer(bot_id, "POST", "/browser/navigate", json={"url": url})),
            user_id=user_id,
            run_id=run_id,
        )

    def read_page(self, agent: Agent, run_context: RunContext) -> str:
        """Read the page currently open in your browser.

        Returns:
            The page URL, title, visible text, and links.
        """
        bot_id, user_id, run_id = _identity(agent, run_context)
        return gated(
            "read_page",
            bot_id,
            "",
            lambda: _page_summary(call_computer(bot_id, "GET", "/browser/page")),
            user_id=user_id,
            run_id=run_id,
        )

    def click(self, target: str, agent: Agent, run_context: RunContext) -> str:
        """Click a link or button on the current page.

        Args:
            target: The element's visible text, or ``css=<selector>``.

        Returns:
            The page after the click.
        """
        bot_id, user_id, run_id = _identity(agent, run_context)
        return gated(
            "click",
            bot_id,
            target,
            lambda: _page_summary(call_computer(bot_id, "POST", "/browser/click", json={"target": target})),
            user_id=user_id,
            run_id=run_id,
        )

    def type_text(self, target: str, text: str, agent: Agent, run_context: RunContext, submit: bool = False) -> str:
        """Type into a field on the current page.

        Args:
            target: The field's label, placeholder, or ``css=<selector>``.
            text: What to type.
            submit: Press Enter afterwards.

        Returns:
            The page afterwards.
        """
        bot_id, user_id, run_id = _identity(agent, run_context)
        body = {"target": target, "text": text, "submit": submit}
        return gated(
            "type_text",
            bot_id,
            target,
            lambda: _page_summary(call_computer(bot_id, "POST", "/browser/type", json=body)),
            user_id=user_id,
            run_id=run_id,
        )

    def run_shell(self, command: str, agent: Agent, run_context: RunContext, timeout: int = 30) -> str:
        """Run a shell command in your own workspace (cwd is your workspace; no secrets in the environment).

        Args:
            command: The shell command line.
            timeout: Seconds before it is killed (max 120).

        Returns:
            JSON with exit_code, stdout, stderr, and timed_out.
        """
        bot_id, user_id, run_id = _identity(agent, run_context)
        body = {"command": command, "timeout": timeout}
        return gated(
            "run_shell",
            bot_id,
            command,
            lambda: json.dumps(call_computer(bot_id, "POST", "/shell", json=body).json()),
            user_id=user_id,
            run_id=run_id,
        )

    def list_files(self, agent: Agent, run_context: RunContext, path: str = "") -> str:
        """List a directory in your workspace.

        Args:
            path: Directory relative to your workspace; empty for its root.

        Returns:
            JSON list of entries with name, type, and size.
        """
        bot_id, user_id, run_id = _identity(agent, run_context)
        return gated(
            "list_files",
            bot_id,
            path,
            lambda: json.dumps(call_computer(bot_id, "GET", "/files", params={"path": path}).json()),
            user_id=user_id,
            run_id=run_id,
        )

    def read_file(self, path: str, agent: Agent, run_context: RunContext) -> str:
        """Read a text file from your workspace.

        Args:
            path: File path relative to your workspace.

        Returns:
            The file's content (capped).
        """
        bot_id, user_id, run_id = _identity(agent, run_context)
        return gated(
            "read_file",
            bot_id,
            path,
            lambda: call_computer(bot_id, "GET", "/files/read", params={"path": path}).json()["content"],
            user_id=user_id,
            run_id=run_id,
        )

    def write_file(self, path: str, content: str, agent: Agent, run_context: RunContext) -> str:
        """Create or overwrite a text file in your workspace.

        Args:
            path: File path relative to your workspace.
            content: The text to write.

        Returns:
            JSON with the path and size written.
        """
        bot_id, user_id, run_id = _identity(agent, run_context)
        body = {"path": path, "content": content}
        return gated(
            "write_file",
            bot_id,
            path,
            lambda: json.dumps(call_computer(bot_id, "POST", "/files/write", json=body).json()),
            user_id=user_id,
            run_id=run_id,
        )
