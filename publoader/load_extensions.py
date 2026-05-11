import ast
import importlib.util
import logging
import re
import sys
import traceback
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import List, Optional, Union

from publoader.models.dataclasses import Chapter, Manga
from publoader.utils.config import CLEAN_TIME, DEFAULT_CLEAN_DAY, DEFAULT_TIME
from publoader.utils.utils import get_current_datetime, root_path
from publoader.webhook import PubloaderWebhook

logger = logging.getLogger("publoader")
EXTENSION_NAME_REGEX = re.compile(r"^([a-z0-9_]+)$")

# Static checks against the most dangerous footguns. This is not a sandbox —
# it just refuses to load extensions that *call* these primitives directly.
# Real isolation needs subprocess/seccomp; the source repos are still trusted.
_DANGEROUS_CALLS = {
    "eval",
    "exec",
    "compile",
    "__import__",
    "os.system",
    "os.popen",
    "os.execv",
    "os.execvp",
    "os.execve",
    "os.execvpe",
    "os.spawnl",
    "os.spawnv",
    "subprocess.run",
    "subprocess.call",
    "subprocess.Popen",
    "subprocess.check_call",
    "subprocess.check_output",
    "subprocess.getoutput",
    "subprocess.getstatusoutput",
    "ctypes.CDLL",
    "ctypes.WinDLL",
    "ctypes.PyDLL",
    "pty.spawn",
    "pty.fork",
}
_DANGEROUS_IMPORT_ROOTS = {"subprocess", "ctypes", "pty"}


def _attr_chain(node: ast.AST) -> Optional[str]:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def _scan_python_file(path: Path) -> List[str]:
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
    except (OSError, UnicodeDecodeError, SyntaxError) as e:
        return [f"{path.name}: could not parse ({e})"]

    issues: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            target = None
            if isinstance(node.func, ast.Name):
                target = node.func.id
            elif isinstance(node.func, ast.Attribute):
                target = _attr_chain(node.func)
            if target and target in _DANGEROUS_CALLS:
                issues.append(f"{path.name}:{node.lineno}: dangerous call {target}()")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".", 1)[0]
                if root in _DANGEROUS_IMPORT_ROOTS:
                    issues.append(
                        f"{path.name}:{node.lineno}: dangerous import {alias.name!r}"
                    )
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".", 1)[0]
            if root in _DANGEROUS_IMPORT_ROOTS:
                issues.append(
                    f"{path.name}:{node.lineno}: dangerous from-import {node.module!r}"
                )
    return issues


def scan_extension_safety(extension_dir: Path) -> List[str]:
    """Return a list of safety issues for any .py file under extension_dir.
    An empty list means the static scan found nothing alarming.
    """
    issues: List[str] = []
    for py_file in extension_dir.rglob("*.py"):
        if "__pycache__" in py_file.parts:
            continue
        issues.extend(_scan_python_file(py_file))
    return issues


def validate_list_chapters(list_to_validate, list_elements_type, return_none=False):
    """Check if variable is a list and the contents of the list are of the specified type."""
    if return_none:
        return None

    if not isinstance(list_to_validate, list):
        raise TypeError("Specified list is not a list.")

    list_elements_correct = [
        item for item in list_to_validate if isinstance(item, list_elements_type)
    ]
    list_elements_wrong = [
        item for item in list_to_validate if not isinstance(item, list_elements_type)
    ]

    length_correct_elements = len(list_elements_correct)
    total_list_elements = len(list_to_validate)

    if length_correct_elements != total_list_elements:
        logger.debug(
            f"{length_correct_elements} out of {total_list_elements} elements in the correct format."
        )

    if list_elements_wrong:
        logger.warning(f"Skipping wrong type elements: {list_elements_wrong}")

    return list_elements_correct


def validate_extension_name(name: Optional[str]):
    """Check if the extension name is valid."""
    if name is not None:
        name = str(name)

    if not bool(EXTENSION_NAME_REGEX.match(name)):
        raise TypeError(f"{name!r} does not match {EXTENSION_NAME_REGEX.pattern}")
    return name


def check_class_has_attribute(
    extension_name: str, extension_class, attribute: str, default=None
):
    """Check if the class has the attribute and return default if not."""
    attribute_class = getattr(extension_class, attribute, None)
    if attribute_class is not None:
        return attribute_class

    logger.error(
        f"{extension_name} class doesn't have the {attribute} attribute, using default value."
    )
    return default


def check_class_has_method(
    extension_name: str, extension_class, method: str, default=None, run=True, **kwargs
):
    """Check if the class has the method and return default if not."""
    method_class = getattr(extension_class, method, None)
    if method_class is not None:
        if callable(method_class):
            if run:
                return method_class(**kwargs)
            else:
                return method_class

    logger.info(
        f"{extension_name} doesn't have the {method} method, using default return value."
    )
    return default


def convert_chapters_datetimes(chapters: List[Chapter]):
    """Convert all the chapter objects to be timezone-aware."""
    for chapter in chapters:
        chapter.chapter_timestamp = chapter.chapter_timestamp.astimezone(
            tz=timezone.utc
        )
        if chapter.chapter_expire is not None:
            chapter.chapter_expire = chapter.chapter_expire.astimezone(tz=timezone.utc)


def check_run_in_range(time_to_run: datetime):
    """Return true if time_to_run is in the range +- 5 minutes from now."""
    now = get_current_datetime()
    start = now - timedelta(minutes=5)
    end = now + timedelta(minutes=5)
    return (
        (time_to_run.day == now.day)
        and (time_to_run.hour == now.hour)
        and (start <= time_to_run <= end)
    )


def check_extension_run(
    extension_name, extension_class, clean_db: bool, general_run: bool
):
    """Check if an extension is scheduled to run."""
    current_time = get_current_datetime()
    current_day = get_current_datetime().weekday()
    days_to_run = []
    time_to_run: Union[time, datetime] = check_class_has_method(
        extension_name, extension_class, "run_at"
    )
    daily_check_run = check_class_has_method(
        extension_name, extension_class, "daily_check_run", default=False
    )

    if isinstance(time_to_run, time):
        time_to_run = datetime.combine(date.today(), time_to_run)

    if not isinstance(time_to_run, (time, datetime)):
        time_to_run = datetime.combine(date.today(), DEFAULT_TIME)

    time_to_run_datetime = current_time.replace(
        day=time_to_run.day,
        hour=time_to_run.hour,
        minute=time_to_run.minute,
        tzinfo=time_to_run.tzinfo,
    )
    time_to_run = time_to_run_datetime.astimezone(tz=timezone.utc)

    days_to_clean_unsanitised = check_class_has_method(
        extension_name, extension_class, "clean_at"
    )

    if not isinstance(days_to_clean_unsanitised, (list, type(None))):
        days_to_clean_unsanitised = None

    # if days_to_clean_unsanitised is None:
    #     days_to_run.append(DEFAULT_CLEAN_DAY)

    cleaned_list = []
    if isinstance(days_to_clean_unsanitised, list):
        for elem in days_to_clean_unsanitised:
            try:
                cleaned_list.append(int(elem))
            except ValueError:
                pass

    if not cleaned_list:
        if isinstance(days_to_clean_unsanitised, list):
            days_to_run.append(DEFAULT_CLEAN_DAY)
    else:
        days_to_run.extend(cleaned_list)

    run_extension = check_run_in_range(time_to_run)

    day_to_run = current_day in days_to_run
    clean_time = current_time.replace(hour=CLEAN_TIME.hour, minute=CLEAN_TIME.minute)
    time_to_clean = check_run_in_range(clean_time)
    clean = time_to_clean and day_to_run

    if time_to_clean:
        logger.info(
            f"Time to clean: Status {clean=} and {daily_check_run=} for {extension_name}"
        )
        if daily_check_run:
            run_extension = True

    if clean:
        run_extension = True

    if general_run:
        run_extension = True

    if clean_db:
        run_extension = True
        clean = True

    return run_extension, clean, time_to_run


def load_extension(extension: Path, clean_db: bool = False, general_run: bool = False):
    """Load the extension."""
    extension_mainfile = extension.joinpath(f"{extension.name}.py")
    if not extension_mainfile.exists():
        logger.error(f"{extension.name} main file does not exist, skipping.")
        return

    normalised_extension_name = f"extensions.{extension.name}"
    print(f"------Loading {normalised_extension_name}------")

    safety_issues = scan_extension_safety(extension)
    if safety_issues:
        formatted = "\n".join(safety_issues)
        logger.error(
            f"{normalised_extension_name} failed safety scan, refusing to load:\n{formatted}"
        )
        print(f"{normalised_extension_name} failed safety scan, skipping.")
        PubloaderWebhook(
            extension_name=normalised_extension_name,
            title=f"{normalised_extension_name} blocked by safety scan",
            description=f"Refusing to load. Issues:\n```\n{formatted[:1500]}\n```",
            colour="FF0000",
        ).send()
        return

    try:
        spec = importlib.util.spec_from_file_location(
            normalised_extension_name, extension_mainfile
        )
        foo = importlib.util.module_from_spec(spec)
        sys.modules[normalised_extension_name] = foo
        spec.loader.exec_module(foo)

        try:
            extension_class = foo.Extension(extension)
        except NameError:
            logger.error(
                f"{normalised_extension_name} doesn't have the Extension class"
            )
            return

        extension_disabled = check_class_has_attribute(
            normalised_extension_name, extension_class, "disabled", default=True
        )
        if extension_disabled:
            logger.info(
                f"{normalised_extension_name} is disabled: {extension_disabled}."
            )
            print(f"{normalised_extension_name} is disabled.")
            return

        run_extension, clean_db, run_at = check_extension_run(
            normalised_extension_name, extension_class, clean_db, general_run
        )
        if not run_extension and not clean_db:
            print(
                f"{normalised_extension_name} is not scheduled to run now, it runs on: "
                f"{run_at}"
            )
            return

        print(f"{clean_db=} for {normalised_extension_name}")
        return {
            "extension": extension_class,
            "clean_db": clean_db,
            "extension_name": normalised_extension_name,
            "run_at": run_at,
        }
    except BaseException as e:
        traceback.print_exc()
        logger.exception(f"------{normalised_extension_name} raised an error.")
        PubloaderWebhook(
            extension_name=normalised_extension_name,
            title=f"Error in {normalised_extension_name}",
            description=f"An exception occurred:\n```\n{str(e)}\n```",
            colour="FF0000",
        ).send()
        return


def load_extensions(names=None, clean_db: bool = False, general_run: bool = False):
    """Load all the extensions in the extensions folder."""
    updates = {}
    extensions_folder = root_path.joinpath("publoader", "extensions", "src")
    extensions_folder.mkdir(parents=True, exist_ok=True)
    names = [name.lower() for name in names] if names is not None else None

    for extension in [
        f for f in extensions_folder.iterdir() if f.is_dir() and f.name != "__pycache__"
    ]:
        if names is not None:
            if extension.name not in names:
                continue
            else:
                general_run = True

        try:
            validate_extension_name(extension.name)
        except TypeError as e:
            logger.warning(f"Skipping as {', '.join(e.args)}")
            continue

        data = load_extension(extension, clean_db=clean_db, general_run=general_run)
        if data is not None and data:
            updates[data["extension_name"]] = data
    return updates


def run_extension(
    database_connection, extension: dict, clean_db_override: bool = False
):
    """Run a single extension."""
    extension_class = extension["extension"]
    clean_db = extension["clean_db"]
    extension_name = extension["extension_name"]

    if clean_db_override:
        clean_db = True

    try:
        logger.info(f"Running {extension_name}.")

        name = check_class_has_attribute(extension_name, extension_class, "name")
        validate_extension_name(name)
        normalised_extension_name = f"extensions.{name}"

        posted_chapters_ids = list(
            database_connection["uploaded_ids"].find({"extension_name": {"$eq": name}})
        )

        posted_chapters_ids = (
            [chap["chapter_id"] for chap in posted_chapters_ids] if not clean_db else []
        )

        update_posted_chapter_ids = check_class_has_method(
            extension_name, extension_class, "update_external_data", run=False
        )
        if update_posted_chapter_ids is None:
            logger.info(f"{extension_name} update_external_data method does not exist.")
        else:
            update_posted_chapter_ids(posted_chapters_ids, clean_db)

        updated_chapters = check_class_has_method(
            extension_name, extension_class, "get_updated_chapters", default=[]
        )
        all_chapters = check_class_has_method(
            extension_name, extension_class, "get_all_chapters", default=None
        )
        untracked_manga = check_class_has_method(
            extension_name, extension_class, "get_updated_manga", default=[]
        )
        tracked_mangadex_ids = check_class_has_attribute(
            extension_name, extension_class, "tracked_mangadex_ids", default=[]
        )
        mangadex_group_id = check_class_has_attribute(
            extension_name, extension_class, "mangadex_group_id"
        )
        override_options = check_class_has_attribute(
            extension_name, extension_class, "override_options", default={}
        )
        extension_languages = check_class_has_attribute(
            extension_name, extension_class, "extension_languages", default=[]
        )

        if mangadex_group_id is not None:
            mangadex_group_id = str(mangadex_group_id)

        try:
            updated_chapters = validate_list_chapters(updated_chapters, Chapter)
        except TypeError:
            logger.error(
                f"{normalised_extension_name} updated chapters is not a list, skipping."
            )
            return

        convert_chapters_datetimes(updated_chapters)

        try:
            all_chapters = validate_list_chapters(
                all_chapters, Chapter, return_none=not clean_db
            )
        except TypeError:
            logger.error(
                f"{normalised_extension_name} all chapters is not a list, initialising list as None."
            )
            all_chapters = None

        if all_chapters is not None:
            convert_chapters_datetimes(all_chapters)

        try:
            untracked_manga = validate_list_chapters(untracked_manga, Manga)
        except TypeError:
            logger.error(
                f"{normalised_extension_name} untracked manga is not a list, initialising list as empty."
            )
            untracked_manga = []

        try:
            tracked_mangadex_ids = validate_list_chapters(tracked_mangadex_ids, str)
        except TypeError:
            logger.error(
                f"{normalised_extension_name} tracked mangadex ids is not a list, skipping."
            )
            return

        try:
            extension_languages = validate_list_chapters(extension_languages, str)
        except TypeError:
            logger.error(
                f"{normalised_extension_name} extension languages is not a list, skipping."
            )
            return

        if not isinstance(override_options, dict):
            logger.error(
                f"{normalised_extension_name} custom regexes is not a dict, initialising as dict."
            )
            override_options = {}

        return {
            "extension": extension_class,
            "name": name,
            "normalised_extension_name": normalised_extension_name,
            "updated_chapters": updated_chapters,
            "all_chapters": all_chapters,
            "untracked_manga": untracked_manga,
            "tracked_mangadex_ids": tracked_mangadex_ids,
            "mangadex_group_id": mangadex_group_id,
            "override_options": override_options,
            "extension_languages": extension_languages,
            "posted_chapters_ids": posted_chapters_ids,
            "clean_db": clean_db,
        }
    except BaseException as e:
        traceback.print_exc()
        logger.exception(f"------{extension_name} raised an error.")
        PubloaderWebhook(
            extension_name=extension_name,
            title=f"Error in {extension_name}",
            description=f"An exception occurred:\n```\n{str(e)}\n```",
            colour="FF0000",
        ).send()
        return


def run_extensions(database_connection, extensions: dict, clean_db_override: bool):
    """Run the extensions to get the updates."""
    updates = {}
    for site in extensions:
        extension = extensions[site]
        extension_name = extension["extension_name"]

        PubloaderWebhook(
            extension_name,
            title=f"Reading data from {extension_name}",
        ).send()

        try:
            data = run_extension(
                database_connection, extension, clean_db_override=clean_db_override
            )
        except BaseException as e:
            traceback.print_exc()
            logger.exception(f"------{extension_name} raised an error.")
            PubloaderWebhook(
                extension_name=extension_name,
                title=f"Error in {extension_name}",
                description=f"An exception occurred:\n```\n{str(e)}\n```",
                colour="FF0000",
            ).send()
            continue

        if data is not None and data:
            updates[site] = data

    return updates
