import pytest

from publoader.load_extensions import _scan_python_file, scan_extension_safety


def _write(path, body):
    path.write_text(body, encoding="utf-8")
    return path


def test_clean_code_is_clean(tmp_path):
    p = _write(tmp_path / "ok.py", "import requests\ndef fetch(): requests.get('x')\n")
    assert _scan_python_file(p) == []


def test_flags_eval(tmp_path):
    p = _write(tmp_path / "bad.py", "eval('1+1')\n")
    issues = _scan_python_file(p)
    assert any("eval" in i for i in issues)


def test_flags_exec(tmp_path):
    p = _write(tmp_path / "bad.py", "exec('print(1)')\n")
    issues = _scan_python_file(p)
    assert any("exec" in i for i in issues)


def test_flags_subprocess_call(tmp_path):
    p = _write(
        tmp_path / "bad.py",
        "import subprocess\nsubprocess.run(['ls'])\n",
    )
    issues = _scan_python_file(p)
    # Both the import and the call should be flagged
    assert any("subprocess" in i for i in issues)
    assert any("subprocess.run" in i for i in issues)


def test_flags_os_system(tmp_path):
    p = _write(tmp_path / "bad.py", "import os\nos.system('rm -rf /')\n")
    issues = _scan_python_file(p)
    assert any("os.system" in i for i in issues)


def test_flags_ctypes_import(tmp_path):
    p = _write(tmp_path / "bad.py", "import ctypes\n")
    issues = _scan_python_file(p)
    assert any("ctypes" in i for i in issues)


def test_flags_pty(tmp_path):
    p = _write(tmp_path / "bad.py", "from pty import spawn\n")
    issues = _scan_python_file(p)
    assert any("pty" in i for i in issues)


def test_handles_syntax_error_gracefully(tmp_path):
    p = _write(tmp_path / "broken.py", "this isn't valid python !!!\n")
    issues = _scan_python_file(p)
    assert any("could not parse" in i.lower() for i in issues)


def test_scan_extension_safety_walks_subdirs(tmp_path):
    ext = tmp_path / "myext"
    ext.mkdir()
    (ext / "myext.py").write_text("def x(): pass\n")
    (ext / "helper.py").write_text("import subprocess\n")
    issues = scan_extension_safety(ext)
    assert any("subprocess" in i for i in issues)


def test_scan_skips_pycache(tmp_path):
    ext = tmp_path / "myext"
    (ext / "__pycache__").mkdir(parents=True)
    (ext / "__pycache__" / "evil.cpython-310.py").write_text("eval('1')")
    (ext / "myext.py").write_text("pass\n")
    assert scan_extension_safety(ext) == []
