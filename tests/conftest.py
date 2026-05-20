"""Shared pytest fixtures.

Many publoader modules read `config.ini` at import time (utils/config.py
raises if it's missing). Tests run from the repo root so the real
config.ini is found; on CI we materialize a stub one if absent.
"""
import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def pytest_configure(config):
    # Make repo root importable so `import publoader.*` works.
    repo_root = str(REPO_ROOT)
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    # Provide a stub config.ini if the real one is missing (CI / fresh clone).
    cfg = REPO_ROOT / "config.ini"
    if not cfg.exists():
        cfg.write_text(_STUB_CONFIG)

    # Make sure tests don't accidentally hit a shared state DB.
    os.environ.setdefault(
        "PUBLOADER_STATE_DB",
        str(REPO_ROOT / "tests" / "_state-test.db"),
    )


_STUB_CONFIG = """\
[Credentials]
MANGADEX_USERNAME=test
MANGADEX_PASSWORD=test
CLIENT_ID=test
CLIENT_SECRET=test
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB_NAME=publoader_test
DISCORD_BOT_TOKEN=

[Options]
MANGADEX_RATELIMIT_TIME=2
MAX_REQUESTS=5
UPLOAD_RETRY=3
BOT_RUN_TIME_DAILY=15:00
BOT_RUN_TIME_CHECKS=01:00
MAX_LOG_DAYS=30

[Paths]
MANGADEX_API_URL=https://api.mangadex.org
MANGADEX_AUTH_URL=https://auth.mangadex.org/realms/mangadex/protocol/openid-connect
RESOURCES_PATH=resources
MDAUTH_PATH=.mdauth
COMMITS_PATH=.commits
WEBHOOK_URL=
MANGA_DATA_PATH=manga_data.json
DISCORD_COMMAND_PREFIX=!
DISCORD_GUILD_ID=
DISCORD_ALLOWED_CHANNELS=
DISCORD_ADMIN_USERS=
DISCORD_ADMIN_ROLES=

[Repo]
REPO_OWNER=publoader
BASE_REPO_PATH=publoader
EXTENSIONS_REPO_PATH=publoader-extensions
GITHUB_ACCESS_TOKEN=
"""


@pytest.fixture
def tmp_repo_dir(tmp_path, monkeypatch):
    """Create a writable scratch dir and chdir into it."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def temp_state_db(tmp_path, monkeypatch):
    """Isolated SQLite state DB per test."""
    db_path = tmp_path / "state.db"
    monkeypatch.setenv("PUBLOADER_STATE_DB", str(db_path))
    # Force the singleton to recreate
    import publoader.state.store as store_mod
    store_mod._singleton = None
    yield db_path
    store_mod._singleton = None
