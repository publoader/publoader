import errno
import os
from pathlib import Path

import pytest

from publoader.utils.utils import atomic_write_text


def test_writes_new_file(tmp_path):
    target = tmp_path / "new.json"
    atomic_write_text(target, '{"a": 1}')
    assert target.read_text() == '{"a": 1}'


def test_overwrites_existing(tmp_path):
    target = tmp_path / "existing.json"
    target.write_text("original")
    atomic_write_text(target, "replaced")
    assert target.read_text() == "replaced"


def test_no_temp_left_behind_on_success(tmp_path):
    target = tmp_path / "x.json"
    atomic_write_text(target, "data")
    leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".")]
    assert leftovers == []


def test_falls_back_to_in_place_on_ebusy(tmp_path, monkeypatch):
    """Bind-mounted files reject rename with EBUSY — we should rewrite in place
    and still leave the target with the new contents."""
    target = tmp_path / "bind.json"
    target.write_text("original")

    real_replace = os.replace
    calls = {"n": 0}

    def fake_replace(src, dst):
        calls["n"] += 1
        if str(dst).endswith("bind.json"):
            raise OSError(errno.EBUSY, "Device or resource busy")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", fake_replace)

    atomic_write_text(target, "fallback wrote me")
    assert target.read_text() == "fallback wrote me"
    assert calls["n"] >= 1


def test_propagates_unrelated_errors(tmp_path, monkeypatch):
    target = tmp_path / "y.json"

    def fake_replace(src, dst):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(os, "replace", fake_replace)
    with pytest.raises(OSError):
        atomic_write_text(target, "x")


def test_cleans_temp_on_failure(tmp_path, monkeypatch):
    target = tmp_path / "z.json"

    def fake_replace(src, dst):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(os, "replace", fake_replace)
    with pytest.raises(OSError):
        atomic_write_text(target, "x")

    leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".")]
    assert leftovers == []
