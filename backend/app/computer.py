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
from collections.abc import Callable
from functools import cache, partial
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


def gated(tool: str, target: str, agent: Agent, run_context: RunContext, run: Callable[[str], Any]) -> str:
    """Decide, audit, then perform one action; returns its result, or the refusal, as text for the model.

    Args:
        tool: Action name the policy matches on.
        target: URL, command, or path the policy inspects and the audit row records.
        agent: The acting agent (injected by Agno); its id selects the computer.
        run_context: The run (injected by Agno), for the audit row's user and run ids.
        run: Performs the action given the bot id; its result is returned as text.
    """
    bot_id = str(agent.id)
    log = partial(
        audit.record,
        bot_id=bot_id,
        tool=tool,
        target=target,
        user_id=run_context.user_id,
        run_id=run_context.run_id,
    )
    decision = policy().decide(Action(tool=tool, bot_id=bot_id, target=target))
    log(decision="allowed" if decision.allowed else "denied", rule=decision.rule)
    if not decision.allowed:
        return f"Refused by policy ({decision.rule}). Do not retry this action; tell the user it is not permitted."
    try:
        return str(run(bot_id))
    except ComputerError as error:
        log(decision="failed", detail=str(error))
        return f"Error: {error}"


def _page(bot_id: str, method: str, path: str, **kwargs: Any) -> str:
    """Call a browser route and summarise the page it answers with."""
    page = call_computer(bot_id, method, path, **kwargs).json()
    links = "\n".join(f"- {link['text'] or '(no text)'}: {link['href']}" for link in page.get("links", [])[:20])
    return f"URL: {page['url']}\nTitle: {page['title']}\n\n{page['text']}\n\nLinks:\n{links}"


def _json(bot_id: str, method: str, path: str, **kwargs: Any) -> str:
    """Call a route and return its JSON answer as text."""
    return json.dumps(call_computer(bot_id, method, path, **kwargs).json())


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
        return gated(
            "browse", url, agent, run_context, lambda bot: _page(bot, "POST", "/browser/navigate", json={"url": url})
        )

    def read_page(self, agent: Agent, run_context: RunContext) -> str:
        """Read the page currently open in your browser.

        Returns:
            The page URL, title, visible text, and links.
        """
        return gated("read_page", "", agent, run_context, lambda bot: _page(bot, "GET", "/browser/page"))

    def click(self, target: str, agent: Agent, run_context: RunContext) -> str:
        """Click a link or button on the current page.

        Args:
            target: The element's visible text, or ``css=<selector>``.

        Returns:
            The page after the click.
        """
        body = {"target": target}
        return gated("click", target, agent, run_context, lambda bot: _page(bot, "POST", "/browser/click", json=body))

    def type_text(self, target: str, text: str, agent: Agent, run_context: RunContext, submit: bool = False) -> str:
        """Type into a field on the current page.

        Args:
            target: The field's label, placeholder, or ``css=<selector>``.
            text: What to type.
            submit: Press Enter afterwards.

        Returns:
            The page afterwards.
        """
        body = {"target": target, "text": text, "submit": submit}
        return gated(
            "type_text", target, agent, run_context, lambda bot: _page(bot, "POST", "/browser/type", json=body)
        )

    def run_shell(self, command: str, agent: Agent, run_context: RunContext, timeout: int = 30) -> str:
        """Run a shell command in your own workspace (cwd is your workspace; no secrets in the environment).

        Args:
            command: The shell command line.
            timeout: Seconds before it is killed (max 120).

        Returns:
            JSON with exit_code, stdout, stderr, and timed_out.
        """
        body = {"command": command, "timeout": timeout}
        return gated("run_shell", command, agent, run_context, lambda bot: _json(bot, "POST", "/shell", json=body))

    def list_files(self, agent: Agent, run_context: RunContext, path: str = "") -> str:
        """List a directory in your workspace.

        Args:
            path: Directory relative to your workspace; empty for its root.

        Returns:
            JSON with the path and its entries (name, type, and size).
        """
        params = {"path": path}
        return gated("list_files", path, agent, run_context, lambda bot: _json(bot, "GET", "/files", params=params))

    def read_file(self, path: str, agent: Agent, run_context: RunContext) -> str:
        """Read a text file from your workspace.

        Args:
            path: File path relative to your workspace.

        Returns:
            The file's content (capped).
        """
        params = {"path": path}
        return gated(
            "read_file",
            path,
            agent,
            run_context,
            lambda bot: call_computer(bot, "GET", "/files/read", params=params).json()["content"],
        )

    def write_file(self, path: str, content: str, agent: Agent, run_context: RunContext) -> str:
        """Create or overwrite a text file in your workspace.

        Args:
            path: File path relative to your workspace.
            content: The text to write.

        Returns:
            JSON with the path and size written.
        """
        body = {"path": path, "content": content}
        return gated("write_file", path, agent, run_context, lambda bot: _json(bot, "POST", "/files/write", json=body))
