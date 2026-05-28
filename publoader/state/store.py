"""SQLite-backed bot state.

The DB lives at `resources/publoader.db` (bind-mounted via Docker so it
survives container restarts). When the DB has entries, they override the
matching extension in `schedule.json`; extensions absent from the DB keep
their JSON defaults. When the file is missing entirely the bot falls back
to JSON only.
"""
import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Dict, Optional

from publoader.utils.utils import root_path

logger = logging.getLogger("publoader")

DEFAULT_DB_PATH = Path(
    os.environ.get(
        "PUBLOADER_STATE_DB",
        str(root_path.joinpath("resources", "publoader.db")),
    )
)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS schedule_overrides (
    extension TEXT PRIMARY KEY,
    hour INTEGER NOT NULL,
    minute INTEGER NOT NULL,
    day INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS run_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    extension TEXT,
    kind TEXT,
    triggered_by TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    success INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

# Default behaviour when an extension drops a chapter and offers no override.
# Marked unavailable preserves the chapter card on MangaDex; "delete" enqueues
# for hard removal via the existing to_delete pipeline.
REMOVAL_MODE_UNAVAILABLE = "unavailable"
REMOVAL_MODE_DELETE = "delete"
VALID_REMOVAL_MODES = (REMOVAL_MODE_UNAVAILABLE, REMOVAL_MODE_DELETE)
DEFAULT_REMOVAL_MODE = REMOVAL_MODE_UNAVAILABLE

_REMOVAL_MODE_KEY = "chapter_removal_mode"


class StateStore:
    """Thin sqlite3 wrapper. Concurrency-safe via WAL + a module lock for
    writes; reads can race but the data is small."""

    def __init__(self, db_path: Path = DEFAULT_DB_PATH):
        self.db_path = Path(db_path)
        self._conn: Optional[sqlite3.Connection] = None
        self._write_lock = threading.Lock()

    # ---------- lifecycle ----------

    def open(self) -> "StateStore":
        if self._conn is not None:
            return self
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            str(self.db_path), check_same_thread=False, timeout=10
        )
        self._conn.row_factory = sqlite3.Row
        with self._write_lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(_SCHEMA)
            self._conn.commit()
        return self

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            finally:
                self._conn = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self.open()
        return self._conn

    def exists_on_disk(self) -> bool:
        return self.db_path.exists()

    # ---------- schedule overrides ----------

    def get_schedule_overrides(self) -> Dict[str, dict]:
        rows = self.conn.execute(
            "SELECT extension, hour, minute, day FROM schedule_overrides"
        ).fetchall()
        out: Dict[str, dict] = {}
        for row in rows:
            entry: dict = {"hour": row["hour"], "minute": row["minute"]}
            if row["day"] is not None:
                entry["day"] = row["day"]
            out[row["extension"]] = entry
        return out

    def has_any_schedule(self) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM schedule_overrides LIMIT 1"
        ).fetchone()
        return row is not None

    def upsert_schedule(
        self,
        extension: str,
        hour: int,
        minute: int,
        day: Optional[int] = None,
    ) -> None:
        with self._write_lock:
            self.conn.execute(
                """
                INSERT INTO schedule_overrides (extension, hour, minute, day)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(extension) DO UPDATE SET
                    hour = excluded.hour,
                    minute = excluded.minute,
                    day = excluded.day,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (extension, hour, minute, day),
            )
            self.conn.commit()

    def remove_schedule(self, extension: str) -> int:
        with self._write_lock:
            cur = self.conn.execute(
                "DELETE FROM schedule_overrides WHERE extension = ?", (extension,)
            )
            self.conn.commit()
            return cur.rowcount

    # ---------- generic settings ----------

    def get_setting(self, key: str) -> Optional[str]:
        row = self.conn.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str) -> None:
        with self._write_lock:
            self.conn.execute(
                """
                INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (key, value),
            )
            self.conn.commit()

    def clear_setting(self, key: str) -> int:
        with self._write_lock:
            cur = self.conn.execute("DELETE FROM settings WHERE key = ?", (key,))
            self.conn.commit()
            return cur.rowcount

    # ---------- chapter removal mode ----------

    def get_removal_mode(self) -> str:
        value = self.get_setting(_REMOVAL_MODE_KEY)
        if value in VALID_REMOVAL_MODES:
            return value
        return DEFAULT_REMOVAL_MODE

    def set_removal_mode(self, mode: str) -> str:
        if mode not in VALID_REMOVAL_MODES:
            raise ValueError(
                f"mode must be one of {VALID_REMOVAL_MODES} (got {mode!r})"
            )
        self.set_setting(_REMOVAL_MODE_KEY, mode)
        return mode

    # ---------- run history (informational; written by the runner) ----------

    def record_run_started(
        self,
        extension: Optional[str],
        kind: str,
        triggered_by: Optional[str],
    ) -> int:
        with self._write_lock:
            cur = self.conn.execute(
                "INSERT INTO run_history (extension, kind, triggered_by) VALUES (?, ?, ?)",
                (extension, kind, triggered_by),
            )
            self.conn.commit()
            return cur.lastrowid

    def record_run_completed(self, run_id: int, success: bool) -> None:
        with self._write_lock:
            self.conn.execute(
                "UPDATE run_history SET completed_at = CURRENT_TIMESTAMP, success = ? WHERE id = ?",
                (1 if success else 0, run_id),
            )
            self.conn.commit()


_singleton: Optional[StateStore] = None
_singleton_lock = threading.Lock()


def get_state_store() -> StateStore:
    """Process-wide singleton. Created lazily so unit tests can swap the path."""
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = StateStore().open()
    return _singleton


def resolve_chapter_removal_mode(extension=None) -> str:
    """Effective removal mode for an extension.

    Precedence: extension.chapter_removal_mode (force override) >
    StateStore global setting > DEFAULT_REMOVAL_MODE. Invalid values
    anywhere in the chain are ignored and fall through.
    """
    if extension is not None:
        override = getattr(extension, "chapter_removal_mode", None)
        if isinstance(override, str) and override in VALID_REMOVAL_MODES:
            return override

    try:
        return get_state_store().get_removal_mode()
    except sqlite3.Error:
        logger.warning("State DB read failed; using default removal mode", exc_info=True)
        return DEFAULT_REMOVAL_MODE
