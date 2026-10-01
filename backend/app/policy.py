"""
Computer Policy
===============

Decides whether a bot may perform a computer action before it happens.

A policy is JSON with ``deny`` and ``allow`` rule lists. Deny rules are checked
first; an action must then match an allow rule, so an empty allow list permits
nothing. Each rule matches on:

- ``tool``: glob over the action name (``browse``, ``click``, ``type_text``,
  ``read_page``, ``run_shell``, ``read_file``, ``write_file``, ``list_files``);
- ``bot``: glob over the bot (agent) id;
- ``host``: glob over the hostname a browser action targets;
- ``pattern``: regular expression searched in the action's target (URL, command, or path).

Independently of the rules, browser actions to private, loopback, link-local, and
cloud-metadata addresses are refused unless ``allow_private_hosts`` is true, so a
bot cannot be steered into the deployment's own network.

Example::

    {"deny": [{"tool": "run_shell", "pattern": "\\\\brm\\\\s+-rf\\\\b"}],
     "allow": [{"tool": "*"}]}
"""

from __future__ import annotations

import ipaddress
import json
import re
import socket
from dataclasses import dataclass, field
from fnmatch import fnmatch
from typing import Any
from urllib.parse import urlparse

DEFAULT_POLICY: dict[str, Any] = {"deny": [], "allow": [{"tool": "*"}]}
BLOCKED_HOSTNAMES = {"localhost", "metadata.google.internal", "metadata"}


@dataclass(frozen=True)
class Action:
    """One computer action a bot wants to take."""

    tool: str
    bot_id: str
    target: str = ""

    @property
    def host(self) -> str:
        """The hostname a browser action targets, or ``""`` for non-URL targets."""
        parsed = urlparse(self.target)
        return (parsed.hostname or "").lower() if parsed.scheme in ("http", "https") else ""


@dataclass(frozen=True)
class Rule:
    """A deny or allow rule; every field that is set must match."""

    tool: str = "*"
    bot: str = "*"
    host: str | None = None
    pattern: re.Pattern[str] | None = None
    source: str = ""

    @classmethod
    def parse(cls, raw: dict[str, Any]) -> Rule:
        unknown = set(raw) - {"tool", "bot", "host", "pattern"}
        if unknown:
            raise ValueError(f"Unknown policy rule field(s): {sorted(unknown)}")
        try:
            pattern = re.compile(raw["pattern"]) if raw.get("pattern") else None
        except re.error as error:
            raise ValueError(f"Invalid pattern {raw['pattern']!r}: {error}") from error
        return cls(
            tool=raw.get("tool", "*"),
            bot=raw.get("bot", "*"),
            host=raw.get("host"),
            pattern=pattern,
            source=json.dumps(raw, sort_keys=True),
        )

    def matches(self, action: Action) -> bool:
        if not fnmatch(action.tool, self.tool) or not fnmatch(action.bot_id, self.bot):
            return False
        if self.host is not None and not fnmatch(action.host, self.host.lower()):
            return False
        return self.pattern is None or bool(self.pattern.search(action.target))


@dataclass(frozen=True)
class Decision:
    """The policy's answer, with the rule that decided it (for the audit log)."""

    allowed: bool
    rule: str


def is_private_host(host: str) -> bool:
    """True when ``host`` is, or resolves to, a loopback, private, link-local, or reserved address."""
    if not host:
        return False
    if host in BLOCKED_HOSTNAMES or host.endswith(".localhost") or host.endswith(".internal"):
        return True
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except OSError:
        return False  # Unresolvable: the browser will fail on its own.
    for address in addresses:
        ip = ipaddress.ip_address(str(address).split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_unspecified:
            return True
    return False


@dataclass(frozen=True)
class Policy:
    """Parsed deny/allow rules plus the private-network guard."""

    deny: tuple[Rule, ...] = ()
    allow: tuple[Rule, ...] = field(default_factory=lambda: (Rule(source='{"tool": "*"}'),))
    allow_private_hosts: bool = False

    @classmethod
    def from_json(cls, text: str | None) -> Policy:
        """Parse a policy; ``None`` or empty means :data:`DEFAULT_POLICY`.

        Raises:
            ValueError: On malformed JSON, unknown fields, or an invalid regex, so a broken
                policy stops startup instead of silently allowing everything.
        """
        raw = json.loads(text) if text else DEFAULT_POLICY
        if not isinstance(raw, dict) or set(raw) - {"deny", "allow", "allow_private_hosts"}:
            raise ValueError("Policy must be an object with only deny, allow, and allow_private_hosts")
        return cls(
            deny=tuple(Rule.parse(rule) for rule in raw.get("deny", [])),
            allow=tuple(Rule.parse(rule) for rule in raw.get("allow", [])),
            allow_private_hosts=bool(raw.get("allow_private_hosts", False)),
        )

    def decide(self, action: Action) -> Decision:
        """Deny rules first, then the private-network guard, then the allow list (fail closed)."""
        for rule in self.deny:
            if rule.matches(action):
                return Decision(False, f"deny {rule.source}")
        if not self.allow_private_hosts and is_private_host(action.host):
            return Decision(False, "private network address")
        for rule in self.allow:
            if rule.matches(action):
                return Decision(True, f"allow {rule.source}")
        return Decision(False, "no allow rule matched")
