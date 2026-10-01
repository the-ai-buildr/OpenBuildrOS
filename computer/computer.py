"""
OpenBuildrOS Computer
=====================

A bot's own computer: a headless Chromium with a persistent profile (so logins
survive), a private ``/workspace`` directory, and a shell that runs inside it.

This service does not decide policy. The backend's gateway (``backend/app/computer``)
decides and audits every action first, then calls here. Every route but ``/health``
requires ``Authorization: Bearer $COMPUTER_TOKEN``.

Each bot is addressed as ``/bots/{bot_id}/...``. In per-bot deployments the
supervisor starts one container of this service per bot, so a bot only ever sees
its own browser, files, and shell; in shared mode (local development, tests) one
instance keeps bots apart by directory and browser context.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from playwright.async_api import Browser, BrowserContext, Locator, Page, Playwright, async_playwright
from pydantic import BaseModel, Field

WORKSPACE_ROOT = Path(os.getenv("WORKSPACE_ROOT", "/workspace"))
COMPUTER_TOKEN = os.getenv("COMPUTER_TOKEN", "")
TEXT_LIMIT = 12_000
OUTPUT_LIMIT = 20_000
SHELL_TIMEOUT_MAX = 120
BOT_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
# Variables a shell command inherits; everything else in this process's environment stays out.
SHELL_ENV_KEYS = ("PATH", "LANG", "LC_ALL", "TERM", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "TZ")


class Session:
    """One bot's browser context, page, and workspace."""

    def __init__(self, bot_id: str, context: BrowserContext, page: Page, workspace: Path) -> None:
        self.bot_id = bot_id
        self.context = context
        self.page = page
        self.workspace = workspace
        self.lock = asyncio.Lock()

    async def save_profile(self) -> None:
        """Persist cookies and storage so the bot stays signed in across restarts."""
        await self.context.storage_state(path=str(self.workspace / ".profile.json"))


class Computer:
    """Owns the shared Chromium and hands out one :class:`Session` per bot."""

    def __init__(self) -> None:
        self.playwright: Playwright | None = None
        self.browser: Browser | None = None
        self.sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(args=["--disable-dev-shm-usage"])

    async def stop(self) -> None:
        for session in self.sessions.values():
            await session.context.close()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()

    async def session(self, bot_id: str) -> Session:
        """Return the bot's session, creating its workspace and browser context on first use."""
        async with self._lock:
            if bot_id in self.sessions:
                return self.sessions[bot_id]
            assert self.browser is not None
            workspace = WORKSPACE_ROOT / bot_id
            workspace.mkdir(parents=True, exist_ok=True)
            profile = workspace / ".profile.json"
            context = await self.browser.new_context(
                storage_state=str(profile) if profile.exists() else None,
                viewport={"width": 1280, "height": 800},
                accept_downloads=True,
            )
            page = await context.new_page()
            self.sessions[bot_id] = Session(bot_id, context, page, workspace)
            return self.sessions[bot_id]

    async def reset(self, bot_id: str) -> None:
        """Close the bot's browser and delete its workspace: a fresh computer."""
        async with self._lock:
            session = self.sessions.pop(bot_id, None)
            if session:
                await session.context.close()
            shutil.rmtree(WORKSPACE_ROOT / bot_id, ignore_errors=True)


computer = Computer()


@asynccontextmanager
async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
    await computer.start()
    try:
        yield
    finally:
        await computer.stop()


app = FastAPI(title="OpenBuildrOS Computer", lifespan=lifespan)


def require_token(authorization: Annotated[str, Header()] = "") -> None:
    """Reject requests without the shared bearer token (compared in constant time)."""
    if not COMPUTER_TOKEN or not hmac.compare_digest(authorization, f"Bearer {COMPUTER_TOKEN}"):
        raise HTTPException(status_code=401, detail="Invalid computer token")


async def bot_session(bot_id: str, _: Annotated[None, Depends(require_token)]) -> Session:
    """Resolve the path's bot id to its session, refusing ids that could escape the workspace root."""
    if not BOT_ID.match(bot_id):
        raise HTTPException(status_code=400, detail="Invalid bot id")
    return await computer.session(bot_id)


BotSession = Annotated[Session, Depends(bot_session)]


def resolve_path(session: Session, relative: str) -> Path:
    """Resolve ``relative`` inside the bot's workspace, refusing anything that escapes it."""
    target = (session.workspace / relative.lstrip("/")).resolve()
    if target != session.workspace.resolve() and session.workspace.resolve() not in target.parents:
        raise HTTPException(status_code=400, detail="Path escapes the workspace")
    return target


async def page_state(page: Page) -> dict[str, Any]:
    """What the bot sees: URL, title, visible text (capped), and the first links."""
    text = await page.inner_text("body") if await page.query_selector("body") else ""
    links = await page.eval_on_selector_all(
        "a[href]", "els => els.slice(0, 40).map(a => ({text: a.innerText.trim().slice(0, 80), href: a.href}))"
    )
    return {"url": page.url, "title": await page.title(), "text": text[:TEXT_LIMIT], "links": links}


class NavigateBody(BaseModel):
    url: str


class ClickBody(BaseModel):
    target: str = Field(description="Visible text of the element, or a CSS selector prefixed with 'css='.")


class TypeBody(BaseModel):
    target: str = Field(description="Label, placeholder, or 'css=<selector>' of the field.")
    text: str
    submit: bool = False


class ShellBody(BaseModel):
    command: str
    timeout: int = 30


class WriteBody(BaseModel):
    path: str
    content: str


def locate(page: Page, target: str) -> Locator:
    """Find an element by CSS (``css=...``), or else by label, placeholder, or visible text."""
    if target.startswith("css="):
        return page.locator(target[4:]).first
    return page.get_by_label(target).or_(page.get_by_placeholder(target)).or_(page.get_by_text(target)).first


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe; no token required."""
    return {"status": "ok"}


@app.post("/bots/{bot_id}/browser/navigate")
async def navigate(body: NavigateBody, session: BotSession) -> dict[str, Any]:
    """Open ``url`` in the bot's browser and return what the page shows."""
    async with session.lock:
        await session.page.goto(body.url, wait_until="domcontentloaded", timeout=30_000)
        await session.save_profile()
        return await page_state(session.page)


@app.get("/bots/{bot_id}/browser/page")
async def read_page(session: BotSession) -> dict[str, Any]:
    """Return the current page's URL, title, text, and links."""
    async with session.lock:
        return await page_state(session.page)


@app.post("/bots/{bot_id}/browser/click")
async def click(body: ClickBody, session: BotSession) -> dict[str, Any]:
    """Click an element and return the page afterwards."""
    async with session.lock:
        await locate(session.page, body.target).click(timeout=10_000)
        await session.page.wait_for_load_state("domcontentloaded")
        await session.save_profile()
        return await page_state(session.page)


@app.post("/bots/{bot_id}/browser/type")
async def type_text(body: TypeBody, session: BotSession) -> dict[str, Any]:
    """Fill a field, optionally pressing Enter, and return the page afterwards."""
    async with session.lock:
        field = locate(session.page, body.target)
        await field.fill(body.text, timeout=10_000)
        if body.submit:
            await field.press("Enter")
            await session.page.wait_for_load_state("domcontentloaded")
        await session.save_profile()
        return await page_state(session.page)


@app.get("/bots/{bot_id}/browser/screenshot")
async def screenshot(session: BotSession) -> Response:
    """A PNG of the bot's screen, for the UI's live view."""
    async with session.lock:
        png = await session.page.screenshot(type="png")
    return Response(content=png, media_type="image/png", headers={"cache-control": "no-store"})


@app.post("/bots/{bot_id}/shell")
async def shell(body: ShellBody, session: BotSession) -> dict[str, Any]:
    """Run a command in the bot's workspace with a minimal environment and a hard timeout."""
    timeout = max(1, min(body.timeout, SHELL_TIMEOUT_MAX))
    env = {key: os.environ[key] for key in SHELL_ENV_KEYS if key in os.environ}
    env["HOME"] = str(session.workspace)
    process = await asyncio.create_subprocess_shell(
        body.command,
        cwd=session.workspace,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        return {"exit_code": None, "stdout": "", "stderr": f"Timed out after {timeout}s", "timed_out": True}
    return {
        "exit_code": process.returncode,
        "stdout": stdout.decode(errors="replace")[-OUTPUT_LIMIT:],
        "stderr": stderr.decode(errors="replace")[-OUTPUT_LIMIT:],
        "timed_out": False,
    }


@app.get("/bots/{bot_id}/files")
async def list_files(session: BotSession, path: str = "") -> dict[str, Any]:
    """List a workspace directory (hidden entries such as the browser profile are omitted)."""
    directory = resolve_path(session, path)
    if not directory.is_dir():
        raise HTTPException(status_code=404, detail="No such directory")
    entries = [
        {"name": entry.name, "type": "dir" if entry.is_dir() else "file", "size": entry.stat().st_size}
        for entry in sorted(directory.iterdir())
        if not entry.name.startswith(".")
    ]
    return {"path": path or "/", "entries": entries}


@app.get("/bots/{bot_id}/files/read")
async def read_file(session: BotSession, path: str) -> dict[str, Any]:
    """Read a text file from the workspace (capped)."""
    target = resolve_path(session, path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="No such file")
    data = target.read_bytes()
    return {"path": path, "size": len(data), "content": data[:OUTPUT_LIMIT].decode(errors="replace")}


@app.post("/bots/{bot_id}/files/write")
async def write_file(body: WriteBody, session: BotSession) -> dict[str, Any]:
    """Create or overwrite a text file in the workspace."""
    target = resolve_path(session, body.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content)
    return {"path": body.path, "size": target.stat().st_size}


@app.post("/bots/{bot_id}/reset")
async def reset(bot_id: str, _: Annotated[None, Depends(require_token)]) -> dict[str, str]:
    """Wipe the bot's browser profile and workspace."""
    if not BOT_ID.match(bot_id):
        raise HTTPException(status_code=400, detail="Invalid bot id")
    await computer.reset(bot_id)
    return {"status": "reset"}
