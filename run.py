import argparse
import configparser
import json
import logging
import os
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import time as dtTime, timezone
from importlib import reload
from pathlib import Path
from typing import Optional

from scheduler import Scheduler

from publoader.ipc import IPCServer, ipc_call, is_instance_running
from publoader.state import get_state_store
from publoader.updater import PubloaderUpdater
from publoader.utils.config import (
    config,
    daily_run_time_checks_hour,
    daily_run_time_checks_minute,
    daily_run_time_daily_hour,
    daily_run_time_daily_minute,
)
from publoader.utils.utils import (
    get_current_datetime,
    root_path,
)
from publoader.models.database import get_database_connection
from publoader.workers import worker

logger = logging.getLogger("publoader")

# Job kinds the IPC handlers enqueue for the main loop to drain.
JOB_RUN = "run"
JOB_RESTART = "restart"

# Holds (kind, payload) tuples; populated by IPC threads, drained on main thread.
_ipc_jobs: "queue.Queue" = queue.Queue()
_run_lock = threading.Lock()

# Extensions currently queued-but-not-yet-completed or actively executing.
# Used to reject duplicate /run /force / /clean for the same extension while
# one is in flight, so a re-trigger can't kick off the same extension twice.
_inflight_extensions: set = set()
_inflight_lock = threading.Lock()


def _claim_extensions(names):
    """Atomically claim a set of extension names. Returns (accepted, skipped)."""
    accepted, skipped = [], []
    with _inflight_lock:
        for name in names:
            if name in _inflight_extensions:
                skipped.append(name)
            else:
                _inflight_extensions.add(name)
                accepted.append(name)
    return accepted, skipped


def _release_extensions(names):
    if not names:
        return
    with _inflight_lock:
        _inflight_extensions.difference_update(names)


def main(
    database_connection,
    extension_names: list[str] = None,
    general_run=False,
    clean_db=False,
):
    """Call the main function of the publoader bot."""
    from publoader import publoader

    reload(publoader)
    try:
        with _run_lock:
            publoader.open_extensions(
                database_connection,
                names=extension_names,
                general_run=general_run,
                clean_db=clean_db,
            )
    finally:
        _release_extensions(extension_names or [])


def _open_json_timings() -> dict:
    """Read every `schedule*.json` under publoader/extensions/."""
    timings: dict = {}
    for schedule_file in root_path.joinpath("publoader", "extensions").glob(
        "schedule*.json"
    ):
        try:
            timings.update(json.loads(schedule_file.read_bytes()))
        except json.JSONDecodeError:
            pass
    return timings


def open_timings() -> dict:
    """Effective timings: JSON defaults overridden by DB entries (when present).

    Falls back to JSON-only when the state DB file doesn't exist on disk yet —
    matching the user-stated rule "if a db exists, otherwise just run the
    default from the timings json".
    """
    timings = _open_json_timings()
    try:
        store = get_state_store()
    except sqlite3.Error as e:
        logger.warning(f"State DB unavailable, using schedule.json only: {e}")
        return timings

    if not store.exists_on_disk():
        return timings

    overrides = store.get_schedule_overrides()
    if not overrides:
        return timings

    timings.update(overrides)
    return timings


def schedule_extensions(database_connection):
    """Compute timing buckets and register them with the global `schedule`.
    Returns the bucket list."""
    same: list = []
    timings = open_timings()
    now = get_current_datetime()

    for timing in timings:
        extension_timings = timings[timing]
        day = extension_timings.get("day")
        hour = extension_timings.get("hour", daily_run_time_daily_hour)
        minute = extension_timings.get("minute", daily_run_time_daily_minute)

        # `day` per the extensions-repo contract is day-of-week (0-6, Monday=0).
        if day is not None and day != now.weekday():
            continue

        # Join extensions to run together if they are scheduled to run within
        # seven minutes of each other.
        for bucket in same:
            if (
                hour == bucket["hour"]
                and bucket["minute"] - 7 <= minute <= bucket["minute"] + 7
                and timing not in bucket["extensions"]
            ):
                bucket["extensions"].append(timing)
                break
        else:
            same.append({"hour": hour, "minute": minute, "extensions": [timing]})

    for fixed_timing in same:
        schedule.daily(
            dtTime(
                hour=fixed_timing["hour"],
                minute=fixed_timing["minute"],
                tzinfo=timezone.utc,
            ),
            main,
            weight=1,
            alias=", ".join(fixed_timing["extensions"]),
            tags=set(fixed_timing["extensions"]),
            kwargs={
                "database_connection": database_connection,
                "extension_names": list(fixed_timing["extensions"]),
            },
        )
    return same


def _reschedule_all(database_connection) -> None:
    """Drop every per-extension job and rebuild from the current effective
    timings. Called after `/schedule set` or `/schedule remove` so the live
    scheduler reflects new DB state without a full process restart."""
    sched = globals().get("schedule")
    if sched is None:
        return

    preserved = {"restarter", "daily_checker"}
    for job in list(getattr(sched, "jobs", [])):
        tags = getattr(job, "tags", set()) or set()
        if not (tags & preserved):
            try:
                sched.delete_job(job)
            except Exception:
                logger.exception(
                    "Failed to delete a schedule job during reschedule"
                )

    schedule_extensions(database_connection)


def _requirements_satisfied(req_file) -> bool:
    """Return True if every requirement in `req_file` is already installed.
    Returns False on any unmet requirement, parse failure, VCS/URL spec, or
    nested -r include — so we err on the side of running pip."""
    try:
        from importlib.metadata import PackageNotFoundError, distribution
        from packaging.requirements import InvalidRequirement, Requirement
    except ImportError:
        return False

    try:
        lines = req_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False

    for raw in lines:
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        # Requirement options like -r/-e/-c/--index-url: bail out and let pip handle.
        if line.startswith("-"):
            return False
        # VCS/URL specs (git+https, http://, file://) aren't parseable as Requirements.
        if "://" in line or line.startswith(("git+", "hg+", "svn+", "bzr+")):
            return False

        try:
            req = Requirement(line)
        except InvalidRequirement:
            return False

        if req.marker is not None and not req.marker.evaluate():
            continue

        try:
            dist = distribution(req.name)
        except PackageNotFoundError:
            return False

        if req.specifier and dist.version not in req.specifier:
            return False

    return True


def install_requirements():
    """Install requirements for the extensions, skipping files that are already satisfied."""
    for file in root_path.rglob("requirements.txt"):
        resolved = file.resolve()
        if _requirements_satisfied(resolved):
            print(f"Requirements already satisfied for {resolved}, skipping.")
            continue

        print(f"Installing requirements from {resolved}")
        try:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r", str(resolved)],
                check=False,
            )
        except (FileNotFoundError, OSError) as e:
            logger.error(f"Failed to invoke pip for {resolved}: {e}")
            continue
        print(
            "Requirements installation completed with error code",
            f"{result.returncode} for file {resolved}",
        )


def restart():
    """Restart the script."""
    worker.kill()
    updater = PubloaderUpdater()
    updater.update()
    install_requirements()

    print(f"Restarting with args {sys.executable=} {sys.argv=}")
    os.execv(sys.executable, [sys.executable, sys.argv[0]])


_EXT_NAME_RE = re.compile(r"^[a-z0-9_]+$")


# Repos that `cmd_pull` knows how to update. Path resolution order:
#   1. env var (e.g. PUBLOADER_REPO_EXTENSIONS)
#   2. config.ini [Repos] section (key matches env var minus the prefix, lowercased)
#   3. a sensible default for the docker layout
#
# Each repo entry is (env_var, config_key, default_path).
_REPO_DEFAULTS: dict = {
    "base": ("PUBLOADER_REPO_BASE", "base", str(root_path)),
    "extensions": (
        "PUBLOADER_REPO_EXTENSIONS",
        "extensions",
        str(root_path / "publoader" / "extensions"),
    ),
    "extensions-private": (
        "PUBLOADER_REPO_EXTENSIONS_PRIVATE",
        "extensions_private",
        "",  # no default — only resolved if explicitly configured
    ),
}


def _resolve_repo_path(name: str) -> Optional[Path]:
    """Return the configured filesystem path for a known repo name, or None."""
    entry = _REPO_DEFAULTS.get(name)
    if entry is None:
        return None
    env_var, cfg_key, default_path = entry

    raw = os.environ.get(env_var)
    if not raw:
        try:
            raw = config["Repos"].get(cfg_key) if config.has_section("Repos") else None
        except (KeyError, configparser.NoSectionError):
            raw = None
    if not raw:
        raw = default_path
    raw = (raw or "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def _git_pull(repo_path: Path, timeout: int = 60) -> dict:
    """Run `git pull --ff-only` against repo_path. Returns a serialisable status dict."""
    def _git(*args, t: int = timeout):
        return subprocess.run(
            ["git", "-C", str(repo_path), *args],
            capture_output=True,
            text=True,
            timeout=t,
        )

    try:
        is_wt = _git("rev-parse", "--is-inside-work-tree", t=10)
    except FileNotFoundError:
        return {"ok": False, "error": "git binary not installed"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "git rev-parse timed out"}

    if is_wt.returncode != 0 or is_wt.stdout.strip() != "true":
        return {
            "ok": False,
            "error": (
                f"{repo_path} is not a git working tree — update via image pull "
                "(docker compose pull && docker compose up -d) instead."
            ),
        }

    try:
        before = _git("rev-parse", "HEAD", t=10).stdout.strip()
    except subprocess.TimeoutExpired:
        before = ""

    try:
        pull = _git("pull", "--ff-only")
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "git pull timed out"}

    if pull.returncode != 0:
        return {
            "ok": False,
            "error": (pull.stderr.strip() or pull.stdout.strip() or "git pull failed"),
        }

    try:
        after = _git("rev-parse", "HEAD", t=10).stdout.strip()
    except subprocess.TimeoutExpired:
        after = ""

    return {
        "ok": True,
        "changed": bool(before and after and before != after),
        "before": before,
        "after": after,
        "summary": pull.stdout.strip().splitlines()[-1] if pull.stdout.strip() else "",
    }


def _setup_ipc_server(database_connection) -> IPCServer:
    """Register handlers that enqueue jobs for the main loop to execute."""
    server = IPCServer()

    def cmd_run(req):
        extensions = req.get("extensions")
        if extensions is None and req.get("extension"):
            extensions = [req["extension"]]

        skipped: list = []
        if extensions:
            # Drop names that are already in-flight so the same extension can't
            # be queued twice (otherwise main loop would run it back-to-back).
            extensions, skipped = _claim_extensions(extensions)
            if not extensions:
                return {
                    "queued": False,
                    "skipped": skipped,
                    "reason": "extension(s) already running or queued",
                }

        _ipc_jobs.put(
            (
                JOB_RUN,
                {
                    "extension_names": extensions,
                    "general_run": bool(req.get("force", False)),
                    "clean_db": bool(req.get("clean", False)),
                },
            )
        )
        result = {"queued": True, "extensions": extensions}
        if skipped:
            result["skipped"] = skipped
        return result

    def cmd_reload(_req):
        # The next main() call already reloads the publoader package; queue a no-op run
        # with no extensions which will trigger reload via importlib.reload.
        _ipc_jobs.put((JOB_RUN, {"extension_names": None, "general_run": False, "clean_db": False}))
        return {"reloaded": True}

    def cmd_restart(_req):
        _ipc_jobs.put((JOB_RESTART, {}))
        return {"restarting": True}

    def cmd_status(_req):
        sched = globals().get("schedule")
        return {
            "pid": os.getpid(),
            "jobs": [str(j) for j in getattr(sched, "jobs", [])] if sched else [],
        }

    def cmd_pull(req):
        """Pull the latest changes for one or more repos. The accepted names are
        the keys of _REPO_DEFAULTS plus the alias 'all'."""
        names = req.get("repos") or req.get("repo")
        if isinstance(names, str):
            names = [names]
        if not names:
            return {"ok": False, "error": "no repos requested"}
        if "all" in names:
            names = list(_REPO_DEFAULTS.keys())

        per_repo: dict = {}
        any_changed = False
        any_ok = True
        for name in names:
            entry = _REPO_DEFAULTS.get(name)
            if entry is None:
                per_repo[name] = {"ok": False, "error": f"unknown repo {name!r}"}
                any_ok = False
                continue
            path = _resolve_repo_path(name)
            if path is None:
                per_repo[name] = {
                    "ok": False,
                    "error": f"no path configured for {name!r} — set {entry[0]} or "
                             f"[Repos]/{entry[1]} in config.ini",
                }
                any_ok = False
                continue
            if not path.is_dir():
                per_repo[name] = {"ok": False, "error": f"path missing: {path}"}
                any_ok = False
                continue

            try:
                status = _git_pull(path)
            except Exception as e:  # pragma: no cover - defensive
                logger.exception(f"pull for {name} crashed")
                per_repo[name] = {"ok": False, "error": str(e)}
                any_ok = False
                continue

            status["path"] = str(path)
            per_repo[name] = status
            if not status.get("ok"):
                any_ok = False
            if status.get("changed"):
                any_changed = True

        return {"ok": any_ok, "changed": any_changed, "repos": per_repo}

    def cmd_list_schedule(_req):
        effective = open_timings()
        try:
            db_overrides = get_state_store().get_schedule_overrides()
        except sqlite3.Error as e:
            db_overrides = {}
            logger.warning(f"State DB read failed: {e}")
        return {"ok": True, "effective": effective, "db_overrides": db_overrides}

    def cmd_set_schedule(req):
        ext = (req.get("extension") or "").strip()
        hour = req.get("hour")
        minute = req.get("minute")
        day = req.get("day")

        if not _EXT_NAME_RE.match(ext):
            return {"ok": False, "error": f"invalid extension name: {ext!r}"}
        if not isinstance(hour, int) or not 0 <= hour <= 23:
            return {"ok": False, "error": f"hour must be int 0-23 (got {hour!r})"}
        if not isinstance(minute, int) or not 0 <= minute <= 59:
            return {"ok": False, "error": f"minute must be int 0-59 (got {minute!r})"}
        if day is not None and (not isinstance(day, int) or not 0 <= day <= 6):
            return {"ok": False, "error": f"day must be int 0-6 (Mon=0) or null (got {day!r})"}

        try:
            get_state_store().upsert_schedule(ext, hour, minute, day)
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB write failed: {e}"}

        try:
            _reschedule_all(database_connection)
        except Exception as e:  # pragma: no cover - defensive
            logger.exception("reschedule failed")
            return {
                "ok": True,
                "stored": True,
                "rescheduled": False,
                "error": f"stored but reschedule failed: {e}",
            }
        return {"ok": True, "stored": True, "rescheduled": True}

    def cmd_remove_schedule(req):
        ext = (req.get("extension") or "").strip()
        if not _EXT_NAME_RE.match(ext):
            return {"ok": False, "error": f"invalid extension name: {ext!r}"}
        try:
            removed = get_state_store().remove_schedule(ext)
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB write failed: {e}"}

        if removed == 0:
            return {"ok": True, "removed": False, "reason": "no DB override existed"}

        try:
            _reschedule_all(database_connection)
        except Exception as e:  # pragma: no cover - defensive
            logger.exception("reschedule failed")
            return {
                "ok": True,
                "removed": True,
                "rescheduled": False,
                "error": str(e),
            }
        return {"ok": True, "removed": True, "rescheduled": True}

    def cmd_get_removal_mode(_req):
        from publoader.state.store import (
            DEFAULT_REMOVAL_MODE,
            VALID_REMOVAL_MODES,
        )
        try:
            mode = get_state_store().get_removal_mode()
            row_set = get_state_store().get_setting("chapter_removal_mode")
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB read failed: {e}"}
        return {
            "ok": True,
            "mode": mode,
            "explicit": row_set is not None,
            "default": DEFAULT_REMOVAL_MODE,
            "valid_modes": list(VALID_REMOVAL_MODES),
        }

    def cmd_set_removal_mode(req):
        from publoader.state.store import VALID_REMOVAL_MODES
        mode = (req.get("mode") or "").strip().lower()
        if mode not in VALID_REMOVAL_MODES:
            return {
                "ok": False,
                "error": (
                    f"mode must be one of {list(VALID_REMOVAL_MODES)} (got {mode!r})"
                ),
            }
        try:
            get_state_store().set_removal_mode(mode)
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB write failed: {e}"}
        return {"ok": True, "mode": mode}

    server.register("run", cmd_run)
    server.register("reload", cmd_reload)
    server.register("restart", cmd_restart)
    server.register("status", cmd_status)
    server.register("pull", cmd_pull)
    server.register("list_schedule", cmd_list_schedule)
    server.register("set_schedule", cmd_set_schedule)
    server.register("remove_schedule", cmd_remove_schedule)
    server.register("get_removal_mode", cmd_get_removal_mode)
    server.register("set_removal_mode", cmd_set_removal_mode)
    server.start()
    return server


def _drain_ipc_jobs(database_connection) -> None:
    """Pull queued IPC jobs and execute them. Called from the main loop."""
    while True:
        try:
            kind, payload = _ipc_jobs.get_nowait()
        except queue.Empty:
            return

        try:
            if kind == JOB_RUN:
                main(database_connection=database_connection, **payload)
            elif kind == JOB_RESTART:
                restart()
            else:
                logger.warning(f"Unknown IPC job kind: {kind!r}")
        except Exception:
            logger.exception(f"IPC job {kind!r} failed")


def _build_dispatch_payload(vargs: dict) -> dict:
    extension = vargs.get("extension")
    if extension:
        extensions = [str(e).strip() for e in extension]
    else:
        extensions = None
    return {
        "extensions": extensions,
        "force": bool(vargs.get("force")),
        "clean": bool(vargs.get("clean")),
    }


def _dispatch_to_running_instance(vargs: dict) -> int:
    """Forward a CLI invocation to the running instance over IPC. Returns exit code."""
    if vargs.get("update"):
        result = ipc_call("restart")
    else:
        result = ipc_call("run", **_build_dispatch_payload(vargs))
    print(f"Dispatched to running instance: {result}")
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--clean",
        "-c",
        default=False,
        const=True,
        nargs="?",
        help="Clean the database.",
    )
    parser.add_argument(
        "--force",
        "-f",
        default=False,
        const=True,
        nargs="?",
        help="Force run the bot, if extensions is unspecified, run all.",
    )
    parser.add_argument(
        "--extension",
        "-e",
        action="append",
        required=False,
        help="Run a specific extension.",
    )
    parser.add_argument(
        "--update",
        "-u",
        default=False,
        const=True,
        nargs="?",
        help="Update the bot.",
    )

    vargs = vars(parser.parse_args())

    # Single-instance gate — second invocations forward to the running one.
    if is_instance_running():
        sys.exit(_dispatch_to_running_instance(vargs))

    if vargs["update"]:
        restart()

    database_connection = get_database_connection()
    worker.main(database_connection)
    ipc_server = _setup_ipc_server(database_connection)

    if vargs["extension"] is None:
        extension_to_run = None
    else:
        extension_to_run = [str(extension).strip() for extension in vargs["extension"]]

    if vargs["force"] or vargs["clean"]:
        main(
            database_connection,
            extension_names=extension_to_run,
            general_run=vargs["force"],
            clean_db=vargs["clean"],
        )

    print(
        "--------------------------------------------------Starting scheduler--------------------------------------------------"
    )
    schedule = Scheduler(tzinfo=timezone.utc, max_exec=1)
    schedule.daily(
        dtTime(
            hour=0,
            minute=0,
            tzinfo=timezone.utc,
        ),
        restart,
        weight=9,
        alias="restarter",
        tags={"restarter"},
    )
    schedule.daily(
        dtTime(
            hour=daily_run_time_checks_hour,
            minute=daily_run_time_checks_minute,
            tzinfo=timezone.utc,
        ),
        main,
        weight=8,
        alias="daily_checker",
        tags={"daily_checker"},
        kwargs={
            "database_connection": database_connection,
        },
    )
    schedule_extensions(database_connection)
    print(schedule)

    try:
        while True:
            schedule.exec_jobs()
            _drain_ipc_jobs(database_connection)
            time.sleep(1)
    except KeyboardInterrupt:
        ipc_server.stop()
        worker.kill()
        sys.exit(1)
