"""
Audit Log
=========

Every computer action is recorded before it runs (allowed or denied) and again if it
fails, in the platform database, so the record exists even when the action does not.
"""

from __future__ import annotations

import time
from functools import cache
from typing import Any

from sqlalchemy import Column, Float, Integer, MetaData, String, Table, Text, insert, select
from sqlalchemy.engine import Engine

from app.db import get_db

metadata = MetaData()

audit_table = Table(
    "openbuildr_audit",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("created_at", Float, nullable=False, index=True),
    Column("bot_id", String(128), nullable=False, index=True),
    Column("user_id", String(128)),
    Column("run_id", String(64)),
    Column("tool", String(64), nullable=False),
    Column("target", Text),
    # "allowed", "denied", or "failed"
    Column("decision", String(16), nullable=False),
    Column("rule", Text),
    Column("detail", Text),
)


@cache
def engine() -> Engine:
    """The platform database engine, with the audit table created on first use."""
    db_engine: Engine = get_db().db_engine  # type: ignore[attr-defined]
    metadata.create_all(db_engine, tables=[audit_table])
    return db_engine


def record(
    *,
    bot_id: str,
    tool: str,
    decision: str,
    target: str = "",
    rule: str = "",
    detail: str = "",
    user_id: str | None = None,
    run_id: str | None = None,
) -> None:
    """Append one audit row."""
    with engine().begin() as connection:
        connection.execute(
            insert(audit_table).values(
                created_at=time.time(),
                bot_id=bot_id,
                user_id=user_id,
                run_id=run_id,
                tool=tool,
                target=target[:2000],
                decision=decision,
                rule=rule[:500],
                detail=detail[:2000],
            )
        )


def recent(bot_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    """The newest audit rows, optionally for one bot."""
    query = select(audit_table).order_by(audit_table.c.id.desc()).limit(max(1, min(limit, 500)))
    if bot_id:
        query = query.where(audit_table.c.bot_id == bot_id)
    with engine().connect() as connection:
        return [dict(row._mapping) for row in connection.execute(query)]
