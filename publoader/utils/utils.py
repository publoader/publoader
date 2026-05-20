import datetime
import errno
import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Dict

logger = logging.getLogger("publoader")

root_path = Path(".")


def atomic_write_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    """Write content to path via temp-file + os.replace so a crash mid-write
    can never leave a half-written file at the destination.

    If the target is a Docker bind-mounted file (rename returns EBUSY because
    the mount is held by the kernel), fall back to an in-place rewrite. We
    lose atomicity in that case, but it's the only thing rename() can't do.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding=encoding) as tmp:
            tmp.write(content)
            tmp.flush()
            os.fsync(tmp.fileno())

        try:
            os.replace(tmp_name, path)
            return
        except OSError as e:
            if e.errno not in (errno.EBUSY, errno.EXDEV, errno.EPERM):
                raise
            # Bind-mounted or cross-device target — rewrite in place.
            with open(path, "w", encoding=encoding) as fp:
                fp.write(content)
                fp.flush()
                os.fsync(fp.fileno())
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        except OSError:
            logger.debug(f"Couldn't clean up temp file {tmp_name}", exc_info=True)


def open_manga_id_map(manga_map_path: Path) -> dict:
    """Open external id to mangadex id map."""
    try:
        with open(manga_map_path, "r") as manga_map_fp:
            manga_map = json.load(manga_map_fp)
    except json.JSONDecodeError as e:
        logger.critical("Manga map file is corrupted.")
        raise json.JSONDecodeError(
            msg="Manga map file is corrupted.", doc=e.doc, pos=e.pos
        )
    except FileNotFoundError:
        logger.critical("Manga map file is missing.")
        raise FileNotFoundError("Couldn't file manga map file.")
    return manga_map


def open_title_regex(override_options_path: Path) -> dict:
    """Open the custom regexes."""
    try:
        with open(override_options_path, "r") as title_regex_fp:
            override_options = json.load(title_regex_fp)
    except json.JSONDecodeError:
        logger.error(f"Title regex file is corrupted: {override_options_path}")
        return {}
    except FileNotFoundError:
        # Optional file — extensions may have no overrides at all.
        logger.info(f"No title regex file at {override_options_path}, using empty.")
        return {}
    return override_options


def open_manga_data(manga_data_path: Path) -> Dict[str, dict]:
    """Open MangaDex titles data."""
    manga_data: Dict[str, dict] = {}
    try:
        with open(manga_data_path, "r") as manga_data_fp:
            manga_data = json.load(manga_data_fp)
    except json.JSONDecodeError:
        logger.error(f"Manga data file is corrupted: {manga_data_path}")
    except FileNotFoundError:
        # Expected on first run — _get_manga_data_md populates and writes it.
        logger.info(f"No manga data file at {manga_data_path}, starting empty.")
    return manga_data


def get_current_datetime():
    """Get current datetime as timezone-aware."""
    return datetime.datetime.now(tz=datetime.timezone.utc)


chapter_number_regex = re.compile(r"^(0|[1-9]\d*)((\.\d+){1,2})?[a-z]?$", re.I)
EXPIRE_TIME = datetime.datetime(year=1990, month=1, day=1, tzinfo=datetime.timezone.utc)
