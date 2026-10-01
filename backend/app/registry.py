"""
Studio Registry
===============

The palette Platform Builder may compose agents, teams, and workflows from.

Only what is declared here is buildable from the UI. Adding a capability for
user-built agents means adding a reviewed toolkit or function to this list.
"""

from __future__ import annotations

from agno.registry import Registry
from agno.tools.calculator import CalculatorTools
from agno.tools.file.generation import FileGenerationTools
from agno.tools.websearch import WebSearchTools

from app.computer import ComputerTools
from app.db import get_db
from app.functions import extract_json, extract_urls
from app.settings import build_model, get_settings

# A bot's own computer (browser, workspace, shell), when the deployment runs computers.
computer_tools = [ComputerTools()] if get_settings().computer_mode != "off" else []

registry = Registry(
    name="OpenBuildrOS Registry",
    tools=[
        CalculatorTools(),
        WebSearchTools(),
        # In-memory run artifacts only; PDF/DOCX need extra native deps.
        FileGenerationTools(enable_pdf_generation=False, enable_docx_generation=False),
        *computer_tools,
    ],
    models=[build_model()],
    dbs=[get_db()],
    functions=[extract_json, extract_urls],
)
