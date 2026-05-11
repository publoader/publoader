import datetime
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
    can never leave a half-written file at the destination."""
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
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


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
    except json.JSONDecodeError as e:
        logger.critical("Title regex file is corrupted.")
        return {}
    except FileNotFoundError:
        logger.critical("Title regex file is missing.")
        return {}
    return override_options


def open_manga_data(manga_data_path: Path) -> Dict[str, dict]:
    """Open MangaDex titles data."""
    manga_data = {}
    try:
        with open(manga_data_path, "r") as manga_data_fp:
            manga_data = json.load(manga_data_fp)
    except json.JSONDecodeError as e:
        logger.error("Manga data file is corrupted.")
    except FileNotFoundError:
        logger.error("Manga data file is missing.")
    return manga_data


def get_current_datetime():
    """Get current datetime as timezone-aware."""
    return datetime.datetime.now(tz=datetime.timezone.utc)


chapter_number_regex = re.compile(r"^(0|[1-9]\d*)((\.\d+){1,2})?[a-z]?$", re.I)
EXPIRE_TIME = datetime.datetime(year=1990, month=1, day=1, tzinfo=datetime.timezone.utc)
