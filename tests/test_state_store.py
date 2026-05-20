import sqlite3
from pathlib import Path

import pytest

from publoader.state.store import StateStore


@pytest.fixture
def store(tmp_path):
    s = StateStore(tmp_path / "state.db").open()
    yield s
    s.close()


def test_starts_empty(store):
    assert store.has_any_schedule() is False
    assert store.get_schedule_overrides() == {}


def test_upsert_then_read(store):
    store.upsert_schedule("mangaplus", 15, 5, None)
    store.upsert_schedule("webtoon", 22, 0, 3)
    overrides = store.get_schedule_overrides()
    assert overrides == {
        "mangaplus": {"hour": 15, "minute": 5},
        "webtoon": {"hour": 22, "minute": 0, "day": 3},
    }
    assert store.has_any_schedule() is True


def test_upsert_replaces(store):
    store.upsert_schedule("mangaplus", 1, 1, None)
    store.upsert_schedule("mangaplus", 12, 30, 4)
    assert store.get_schedule_overrides() == {
        "mangaplus": {"hour": 12, "minute": 30, "day": 4}
    }


def test_remove(store):
    store.upsert_schedule("mangaplus", 1, 1, None)
    assert store.remove_schedule("mangaplus") == 1
    assert store.remove_schedule("mangaplus") == 0
    assert store.get_schedule_overrides() == {}


def test_run_history(store):
    rid = store.record_run_started("mangaplus", "manual", "user:123")
    assert isinstance(rid, int)
    store.record_run_completed(rid, True)


def test_exists_on_disk(tmp_path):
    db_path = tmp_path / "state.db"
    s = StateStore(db_path)
    assert s.exists_on_disk() is False
    s.open()
    assert s.exists_on_disk() is True
    s.close()


def test_wal_mode_enabled(store):
    cur = store.conn.execute("PRAGMA journal_mode")
    mode = cur.fetchone()[0]
    assert mode.lower() == "wal"
