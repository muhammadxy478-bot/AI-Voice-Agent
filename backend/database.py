"""SQLite persistence layer for chat sessions and message transcripts."""

from __future__ import annotations

import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from backend.personas import DEFAULT_PERSONA_NAME, get_persona


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ChatDatabase:
    """Thread-safe SQLite store (executed via asyncio.to_thread from async endpoints)."""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        """Open a SQLite connection and always close the handle on exit (important on Windows)."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys = ON;")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_db(self) -> None:
        """Initialize schema and WAL journal mode."""
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL;")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    persona TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                    content TEXT NOT NULL,
                    latency_ms REAL,
                    ttft_ms REAL,
                    tokens INTEGER,
                    tokens_per_sec REAL,
                    model TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_messages_session
                    ON messages(session_id, id);
                """
            )

    @staticmethod
    def _row_to_session(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "title": row["title"],
            "persona": row["persona"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "message_count": int(row["message_count"]) if "message_count" in row.keys() else 0,
        }

    @staticmethod
    def _row_to_message(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "session_id": row["session_id"],
            "role": row["role"],
            "content": row["content"],
            "latency_ms": row["latency_ms"],
            "ttft_ms": row["ttft_ms"],
            "tokens": row["tokens"],
            "tokens_per_sec": row["tokens_per_sec"],
            "model": row["model"],
            "created_at": row["created_at"],
        }

    def list_sessions(self, query: Optional[str] = None) -> list[dict[str, Any]]:
        """List sessions ordered by most recently updated, optionally filtered by query."""
        search = (query or "").strip().lower()
        with self._connect() as conn:
            if search:
                like = f"%{search}%"
                rows = conn.execute(
                    """
                    SELECT s.*, COUNT(m.id) AS message_count
                    FROM sessions s
                    LEFT JOIN messages m ON m.session_id = s.id
                    WHERE LOWER(s.title) LIKE ?
                       OR LOWER(s.persona) LIKE ?
                       OR EXISTS (
                           SELECT 1 FROM messages m2
                           WHERE m2.session_id = s.id AND LOWER(m2.content) LIKE ?
                       )
                    GROUP BY s.id
                    ORDER BY s.updated_at DESC, s.rowid DESC
                    """,
                    (like, like, like),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT s.*, COUNT(m.id) AS message_count
                    FROM sessions s
                    LEFT JOIN messages m ON m.session_id = s.id
                    GROUP BY s.id
                    ORDER BY s.updated_at DESC, s.rowid DESC
                    """
                ).fetchall()
        return [self._row_to_session(row) for row in rows]

    def create_session(
        self,
        title: str = "New Conversation",
        persona: str = DEFAULT_PERSONA_NAME,
    ) -> dict[str, Any]:
        """Create and persist a new chat session."""
        session_id = str(uuid.uuid4())
        clean_title = (title or "").strip() or "New Conversation"
        resolved_persona = get_persona(persona)["name"]
        now = _utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions (id, title, persona, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, clean_title, resolved_persona, now, now),
            )
        return {
            "id": session_id,
            "title": clean_title,
            "persona": resolved_persona,
            "created_at": now,
            "updated_at": now,
            "message_count": 0,
        }

    def get_session(self, session_id: str) -> Optional[dict[str, Any]]:
        """Return a session by ID or None if not found."""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT s.*, COUNT(m.id) AS message_count
                FROM sessions s
                LEFT JOIN messages m ON m.session_id = s.id
                WHERE s.id = ?
                GROUP BY s.id
                """,
                (session_id,),
            ).fetchone()
        return self._row_to_session(row) if row else None

    def update_session(
        self,
        session_id: str,
        title: Optional[str] = None,
        persona: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        """Update session title and/or persona and return the updated record."""
        fields: list[str] = []
        values: list[Any] = []
        if title is not None:
            clean_title = title.strip()
            if clean_title:
                fields.append("title = ?")
                values.append(clean_title)
        if persona is not None:
            fields.append("persona = ?")
            values.append(get_persona(persona)["name"])

        if not fields:
            return self.get_session(session_id)

        fields.append("updated_at = ?")
        values.append(_utc_now())
        values.append(session_id)

        with self._connect() as conn:
            cur = conn.execute(
                f"UPDATE sessions SET {', '.join(fields)} WHERE id = ?",
                values,
            )
            if cur.rowcount == 0:
                return None
        return self.get_session(session_id)

    def delete_session(self, session_id: str) -> bool:
        """Delete a session and its cascaded messages."""
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            return cur.rowcount > 0

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        latency_ms: Optional[float] = None,
        ttft_ms: Optional[float] = None,
        tokens: Optional[int] = None,
        tokens_per_sec: Optional[float] = None,
        model: Optional[str] = None,
    ) -> dict[str, Any]:
        """Insert a message into a session and bump session updated_at."""
        now = _utc_now()
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO messages (
                    session_id, role, content, latency_ms, ttft_ms,
                    tokens, tokens_per_sec, model, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    role,
                    content,
                    latency_ms,
                    ttft_ms,
                    tokens,
                    tokens_per_sec,
                    model,
                    now,
                ),
            )
            conn.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                (now, session_id),
            )
            row_id = cur.lastrowid
            row = conn.execute(
                "SELECT * FROM messages WHERE id = ?",
                (row_id,),
            ).fetchone()
        return self._row_to_message(row)

    def get_messages(
        self,
        session_id: str,
        limit: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        """Return messages for a session in chronological order."""
        with self._connect() as conn:
            if limit is not None and limit > 0:
                rows = conn.execute(
                    """
                    SELECT * FROM (
                        SELECT * FROM messages
                        WHERE session_id = ?
                        ORDER BY id DESC
                        LIMIT ?
                    )
                    ORDER BY id ASC
                    """,
                    (session_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM messages
                    WHERE session_id = ?
                    ORDER BY id ASC
                    """,
                    (session_id,),
                ).fetchall()
        return [self._row_to_message(row) for row in rows]
