import logging
from datetime import date, datetime, timedelta
from pathlib import Path

from publoader.utils.config import max_log_days
from publoader.utils.utils import root_path

logs_root_path = root_path.joinpath("logs")
logs_root_path.mkdir(parents=True, exist_ok=True)


def format_log_dir_path(directory_name: str):
    log_folder_path = logs_root_path.joinpath(directory_name)
    log_folder_path.mkdir(parents=True, exist_ok=True)
    return log_folder_path


current_date = date.today()
last_date_keep_logs = current_date - timedelta(days=max_log_days)

bot_logs_folder_path = format_log_dir_path("bot")
worker_logs_folder_path = format_log_dir_path("workers")
extensions_logs_folder_path = format_log_dir_path("extensions")
webhook_logs_folder_path = format_log_dir_path("webhook")
debug_logs_folder_path = format_log_dir_path("debug")


def setup_logs(
    logger_name: str,
    path: Path = bot_logs_folder_path,
    logger_filename: str = None,
):
    """Setup the logger with the specified name."""
    path.mkdir(exist_ok=True, parents=True)
    if logger_filename is None:
        logger_filename = logger_name

    filename = f"{logger_filename}_{str(current_date)}.log"

    logs_path = path.joinpath(filename)
    fileh = logging.FileHandler(logs_path, "a")
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)-8s [%(filename)s:%(funcName)s:%(lineno)d] %(message)s"
    )
    fileh.setFormatter(formatter)

    log = logging.getLogger(logger_name)  # root logger
    for hdlr in log.handlers[:]:  # remove all old handlers
        if isinstance(hdlr, logging.FileHandler):
            log.removeHandler(hdlr)
    log.addHandler(fileh)
    log.setLevel(logging.DEBUG)


def setup_extension_logs(
    logger_name: str,
    logger_filename: str = None,
):
    """Setup the logger for an extension.
    The extension folder name will be the same as the logger_name.

    logger_filename must not contain an extension.
    """
    setup_logs(
        logger_name=logger_name,
        path=extensions_logs_folder_path.joinpath(logger_name),
        logger_filename=logger_filename,
    )


setup_logs(
    logger_name="publoader",
    path=bot_logs_folder_path,
    logger_filename="publoader",
)
setup_logs(
    logger_name="debug",
    path=debug_logs_folder_path,
    logger_filename="publoader_debug",
)
setup_logs(
    logger_name="webhook",
    path=webhook_logs_folder_path,
    logger_filename="webhook",
)
setup_logs("publoader-uploader", worker_logs_folder_path.joinpath("uploader"))
setup_logs("publoader-editor", worker_logs_folder_path.joinpath("editor"))
setup_logs("publoader-deleter", worker_logs_folder_path.joinpath("deleter"))
setup_logs("publoader-unavailable", worker_logs_folder_path.joinpath("unavailable"))

_logger = logging.getLogger("publoader")


def clear_old_logs(folder_path: Path):
    for log_file in folder_path.rglob("*.log"):
        try:
            stat = log_file.stat()
        except FileNotFoundError:
            continue

        # Empty log files: previously gated by `< 0`, which is unreachable.
        if stat.st_size < 1:
            _logger.debug(f"{log_file.name} is empty, deleting.")
            try:
                log_file.unlink()
            except FileNotFoundError:
                pass
            continue

        if datetime.fromtimestamp(stat.st_mtime).date() < last_date_keep_logs:
            _logger.debug(f"{log_file.name} is over {max_log_days} days old, deleting.")
            try:
                log_file.unlink()
            except FileNotFoundError:
                pass


clear_old_logs(logs_root_path)


def _attach_error_webhook_handler() -> None:
    # Imported here to avoid a circular import: webhook.py imports utils.config,
    # which imports utils.logs only transitively. Calling this after the file
    # logger setup keeps file-only logs working even if bot/webhook is broken.
    try:
        from publoader.webhook import attach_error_webhook_handler
    except Exception:  # pragma: no cover - best-effort
        return
    for name in (
        "publoader",
        "publoader-uploader",
        "publoader-editor",
        "publoader-deleter",
        "publoader-unavailable",
    ):
        attach_error_webhook_handler(name)


_attach_error_webhook_handler()
