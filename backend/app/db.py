"""
Database
========

One shared Agno database for sessions, runs, traces, and Studio components.
"""

from __future__ import annotations

from functools import cache

from agno.db.base import BaseDb
from agno.db.postgres import PostgresDb
from agno.db.sqlite import SqliteDb

from app.settings import get_settings

DB_ID = "openbuildr-db"


def create_db(database_url: str) -> BaseDb:
    """Create the Agno database for a SQLAlchemy URL.

    Args:
        database_url: ``sqlite:///path/to/file.db`` or a Postgres URL such as
            ``postgresql+psycopg://user:pass@host:5432/db``.

    Returns:
        A :class:`SqliteDb` for SQLite URLs, otherwise a :class:`PostgresDb`.
    """
    if database_url.startswith("sqlite"):
        # SqliteDb creates the parent directory itself.
        return SqliteDb(id=DB_ID, db_file=database_url.split("///", 1)[-1])
    return PostgresDb(id=DB_ID, db_url=database_url)


@cache
def get_db() -> BaseDb:
    """Return the process-wide database built from ``DATABASE_URL``.

    Memoized so every agent, the registry, and AgentOS share one engine and pool.
    """
    return create_db(get_settings().database_url)
