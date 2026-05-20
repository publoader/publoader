"""Tests for the /pull command's underlying helpers in run.py.

These tests build a tiny throwaway pair of git repos (origin + clone) so the
real `git pull --ff-only` path is exercised without touching the network."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

import run as run_module


def _has_git() -> bool:
    return shutil.which("git") is not None


pytestmark = pytest.mark.skipif(not _has_git(), reason="git binary not installed")


def _git(repo: Path, *args, check=True):
    proc = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True
    )
    if check:
        assert proc.returncode == 0, proc.stderr
    return proc


@pytest.fixture
def repo_pair(tmp_path):
    """Return (origin_repo, clone_repo) wired up so the clone can fast-forward."""
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(origin, "init", "-b", "main")
    _git(origin, "config", "user.email", "test@example.com")
    _git(origin, "config", "user.name", "Test")
    (origin / "README").write_text("hello\n")
    _git(origin, "add", "README")
    _git(origin, "commit", "-m", "first")

    clone = tmp_path / "clone"
    _git(tmp_path, "clone", str(origin), str(clone))
    _git(clone, "config", "user.email", "test@example.com")
    _git(clone, "config", "user.name", "Test")
    return origin, clone


def test_git_pull_no_changes(repo_pair):
    _, clone = repo_pair
    status = run_module._git_pull(clone, timeout=15)
    assert status["ok"] is True
    assert status["changed"] is False
    assert status["before"] == status["after"]


def test_git_pull_picks_up_new_commit(repo_pair):
    origin, clone = repo_pair
    (origin / "NEW").write_text("new content\n")
    _git(origin, "add", "NEW")
    _git(origin, "commit", "-m", "second")

    status = run_module._git_pull(clone, timeout=15)
    assert status["ok"] is True
    assert status["changed"] is True
    assert status["before"] != status["after"]
    assert (clone / "NEW").exists()


def test_git_pull_rejects_non_git_directory(tmp_path):
    notrepo = tmp_path / "notrepo"
    notrepo.mkdir()
    status = run_module._git_pull(notrepo, timeout=10)
    assert status["ok"] is False
    assert "not a git working tree" in status["error"]


def test_resolve_repo_path_unknown():
    assert run_module._resolve_repo_path("does-not-exist") is None


def test_resolve_repo_path_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLOADER_REPO_BASE", str(tmp_path))
    resolved = run_module._resolve_repo_path("base")
    assert resolved == tmp_path.resolve()


def test_resolve_repo_path_falls_back_to_default(monkeypatch):
    # 'extensions' has a sensible default path even without env override.
    monkeypatch.delenv("PUBLOADER_REPO_EXTENSIONS", raising=False)
    resolved = run_module._resolve_repo_path("extensions")
    # The resolved path must end with /publoader/extensions regardless of the host.
    assert resolved is not None
    assert resolved.name == "extensions"
    assert resolved.parent.name == "publoader"


def test_resolve_repo_path_extensions_private_unconfigured(monkeypatch):
    monkeypatch.delenv("PUBLOADER_REPO_EXTENSIONS_PRIVATE", raising=False)
    # No default — should return None when neither env nor config supplies one.
    assert run_module._resolve_repo_path("extensions-private") is None
