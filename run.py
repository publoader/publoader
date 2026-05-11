import argparse
import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
from datetime import time as dtTime, timezone
from importlib import reload

from scheduler import Scheduler

from publoader.ipc import IPCServer, ipc_call, is_instance_running
from publoader.updater import PubloaderUpdater
from publoader.utils.config import (
    config,
    daily_run_time_checks_hour,
    daily_run_time_checks_minute,
    daily_run_time_daily_hour,
    daily_run_time_daily_minute,
    resources_path,
)
from publoader.utils.utils import (
    atomic_write_text,
    get_current_datetime,
    open_manga_data,
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


def main(
    database_connection,
    extension_names: list[str] = None,
    general_run=False,
    clean_db=False,
):
    """Call the main function of the publoader bot."""
    from publoader import publoader

    reload(publoader)
    with _run_lock:
        publoader.open_extensions(
            database_connection,
            names=extension_names,
            general_run=general_run,
            clean_db=clean_db,
        )


def open_timings():
    """Open the timings file."""
    timings = {}

    for schedule_file in root_path.joinpath("publoader", "extensions").glob(
        "schedule*.json"
    ):
        try:
            timings.update(json.loads(schedule_file.read_bytes()))
        except json.JSONDecodeError:
            pass
    return timings


def schedule_extensions(database_connection):
    """Add the timings to the scheduler."""
    same = []
    timings = open_timings()
    now = get_current_datetime()

    for timing in timings:
        extension_timings = timings[timing]
        day = extension_timings.get("day")
        hour = extension_timings.get("hour", daily_run_time_daily_hour)
        minute = extension_timings.get("minute", daily_run_time_daily_minute)

        if day is not None and day != now.day:
            continue

        # Join extensions to run together if they are scheduled to run within seven minutes of each other
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
            tags=fixed_timing["extensions"],
            kwargs={
                "database_connection": database_connection,
                "extension_names": list(fixed_timing["extensions"]),
            },
        )


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


def _setup_ipc_server(database_connection) -> IPCServer:
    """Register handlers that enqueue jobs for the main loop to execute."""
    server = IPCServer()

    def cmd_run(req):
        extensions = req.get("extensions")
        if extensions is None and req.get("extension"):
            extensions = [req["extension"]]
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
        return {"queued": True, "extensions": extensions}

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

    def cmd_add_series(req):
        data = req.get("data") or {}
        manga_id = data.get("id")
        if not manga_id:
            return {"ok": False, "error": "missing 'id' field"}
        path = resources_path.joinpath(config["Paths"]["manga_data_path"])
        existing = open_manga_data(path)
        existing[manga_id] = data
        try:
            atomic_write_text(path, json.dumps(existing, indent=2))
        except OSError as e:
            return {"ok": False, "error": str(e)}
        return {"saved": manga_id}

    server.register("run", cmd_run)
    server.register("reload", cmd_reload)
    server.register("restart", cmd_restart)
    server.register("status", cmd_status)
    server.register("add_series", cmd_add_series)
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
