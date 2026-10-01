"""
Guarded Studio
==============

Agno's StudioTools already refuses to compose a component that carries the Studio
control plane into a team or workflow. This subclass extends that refusal to every
code-defined admin agent, so a user-built team or workflow can never inherit the
Manager's platform-wide AgentOS tools or the Engineer's source reader.
"""

from __future__ import annotations

from typing import Any

from agno.tools.studio import StudioTools


class PlatformStudioTools(StudioTools):
    """StudioTools that treats the given component ids as privileged.

    Args:
        protected_ids: Ids that may never become a team member or workflow step.
        **kwargs: Passed to :class:`agno.tools.studio.StudioTools`.
    """

    def __init__(self, *, protected_ids: set[str], **kwargs: Any) -> None:
        self._protected_ids = frozenset(protected_ids)
        super().__init__(**kwargs)

    def _privileged_component_ids(self, only_ids: set[str] | None = None) -> set[str]:
        """Studio's privileged ids (those carrying StudioTools) plus the protected ids."""
        protected = self._protected_ids if only_ids is None else self._protected_ids & only_ids
        return set(super()._privileged_component_ids(only_ids)) | set(protected)

    def _component_is_privileged(self, component: Any, seen: set[str] | None = None) -> bool:
        """A protected component is privileged; otherwise defer to Studio's own check."""
        if getattr(component, "id", None) in self._protected_ids:
            return True
        return bool(super()._component_is_privileged(component, seen))
