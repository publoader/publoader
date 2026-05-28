import logging
import traceback
from typing import List, Union

import gridfs
import pymongo
from pymongo import DeleteOne, UpdateOne

from publoader.models.dataclasses import Chapter
from publoader.utils.config import config
from publoader.utils.singleton import Singleton
from publoader.utils.utils import EXPIRE_TIME, get_current_datetime

logger = logging.getLogger("publoader")
logger_debug = logging.getLogger("debug")


class DatabaseConnector(metaclass=Singleton):
    def __init__(self):
        self.database_uri = config["Credentials"]["mongodb_uri"]
        self.database_name = config["Credentials"]["mongodb_db_name"]
        self.database_connection = None

    def connect_db(self):
        if self.database_connection is None:
            client = pymongo.MongoClient(self.database_uri)
            self.database_connection = client[self.database_name]
        return self.database_connection


def get_database_connection():
    database = DatabaseConnector()
    return database.connect_db()


def convert_model_dict(chapter):
    if isinstance(chapter, Chapter):
        chapter = vars(chapter)
    return chapter


def update_database(
    database_connection, chapter: Union[list, Union[Chapter, dict]], **kwargs
):
    """Update the database with the new chapter."""
    if isinstance(chapter, list):
        chapters = [convert_model_dict(c) for c in chapter]
    else:
        chapters = [convert_model_dict(chapter)]

    if not chapters:
        print(f"No chapters to update: {chapters}")
        return

    for chap in chapters:
        chap.pop("_id", None)

    null_chapters = [c for c in chapters if c.get("md_chapter_id") is None]
    if null_chapters:
        logger.debug(
            f"Chapters to insert into database but md_chapter_id is null: {null_chapters}"
        )

    chapters = [c for c in chapters if c.get("md_chapter_id") is not None]
    if not chapters:
        logger.warning("No chapters to add to the database.")
        return

    try:
        result = database_connection["uploaded"].bulk_write(
            [
                UpdateOne(
                    {"md_chapter_id": {"$eq": chap["md_chapter_id"]}},
                    {"$set": chap},
                    upsert=True,
                )
                for chap in chapters
            ]
        )
    except pymongo.errors.BulkWriteError as e:
        traceback.print_exc()
        logger.exception(
            f"{update_database.__name__} raised an error when bulk writing to 'uploaded'."
        )
        return

    logger.info(f"Updated {result.modified_count} chapters on the database.")

    if result.upserted_count > 0:
        logger.info(
            f"Added {result.upserted_count} new chapters to database: {result.upserted_ids}"
        )

    try:
        database_connection["uploaded_ids"].bulk_write(
            [
                UpdateOne(
                    {"chapter_id": {"$eq": chap["chapter_id"]}},
                    {
                        "$setOnInsert": {
                            "chapter_id": chap["chapter_id"],
                            "extension_name": chap["extension_name"],
                            "md_chapter_id": chap["md_chapter_id"],
                        },
                    },
                    upsert=True,
                )
                for chap in chapters
            ]
        )
    except pymongo.errors.BulkWriteError as e:
        traceback.print_exc()
        logger.exception(
            f"{update_database.__name__} raised an error when bulk writing to 'uploaded_ids'."
        )
        return


def update_expired_chapter_database(
    database_connection,
    extension_name: str,
    md_manga_id: str,
    md_chapter: Union[List[dict], dict] = None,
    chapter: Union[list, Union[Chapter, dict]] = None,
    mangadex_manga_data: dict = None,
    **kwargs,
):
    """Update a chapter as expired on the database."""
    if md_chapter is None:
        md_chapter = []

    if chapter is None:
        chapter = []

    if mangadex_manga_data is None:
        mangadex_manga_data = {}

    if not chapter and not md_chapter:
        logger.info(f"No chapters specified to update expired.")
        return

    if isinstance(chapter, Chapter):
        chapter = vars(chapter)

    chapters = [chapter]

    if isinstance(chapter, list):
        chapters = list(map(convert_model_dict, chapter))

    if isinstance(md_chapter, dict):
        md_chapter = [md_chapter]

    for chap in chapters:
        chap["chapter_expire"] = EXPIRE_TIME
        chap["extension_name"] = extension_name

    if isinstance(md_chapter, list):
        chapters.extend(
            [
                {
                    "chapter_lookup": get_current_datetime(),
                    "chapter_timestamp": EXPIRE_TIME,
                    "chapter_expire": EXPIRE_TIME,
                    "chapter_language": md_chap["attributes"]["translatedLanguage"],
                    "chapter_title": md_chap["attributes"]["title"],
                    "chapter_number": md_chap["attributes"]["chapter"],
                    "md_manga_id": md_manga_id,
                    "md_chapter_id": md_chap["id"],
                    "chapter_url": md_chap["attributes"]["externalUrl"],
                    "extension_name": extension_name,
                    "manga_name": mangadex_manga_data.get(md_manga_id, {}).get("title"),
                }
                for md_chap in md_chapter
            ]
        )

    try:
        result = database_connection["to_delete"].bulk_write(
            [
                UpdateOne(
                    {"md_chapter_id": {"$eq": chap["md_chapter_id"]}},
                    {"$set": chap},
                    upsert=True,
                )
                for chap in chapters
            ]
        )
    except pymongo.errors.BulkWriteError as e:
        traceback.print_exc()
        logger.exception(
            f"{update_expired_chapter_database.__name__} raised an error when bulk writing to 'to_delete'."
        )
        return

    logger.info(f"Updated {result.modified_count} chapters to delete on the database.")

    if result.upserted_count > 0:
        logger.info(
            f"Added {result.upserted_count} chapters to delete: {result.upserted_ids}"
        )
    try:
        deleted_result = database_connection["uploaded"].bulk_write(
            [
                DeleteOne(
                    {"md_chapter_id": {"$eq": chap["md_chapter_id"]}},
                )
                for chap in chapters
            ]
        )
    except pymongo.errors.BulkWriteError as e:
        traceback.print_exc()
        logger.exception(
            f"{update_expired_chapter_database.__name__} raised an error when bulk writing to 'uploaded'."
        )
        return

    logger.info(f"Deleted {deleted_result.deleted_count} from 'uploaded' collection.")


def mark_chapters_unavailable(
    database_connection,
    extension_name: str,
    md_manga_id: str,
    md_chapter: Union[List[dict], dict] = None,
    chapter: Union[list, Union[Chapter, dict]] = None,
    mangadex_manga_data: dict = None,
    **kwargs,
):
    """Mark chapters as no-longer-available on the publisher side.

    Instead of deleting them on MangaDex like update_expired_chapter_database
    does, these are queued in the `to_unavailable` collection. A dedicated
    worker (workers/unavailable.py) then strips the externalUrl on the live
    chapter via the MD API, leaving the pre-uploaded chapter card image as
    the visible content. After successful processing the row moves into the
    `unavailable` archive collection (never hard-deleted)."""
    if md_chapter is None:
        md_chapter = []
    if chapter is None:
        chapter = []
    if mangadex_manga_data is None:
        mangadex_manga_data = {}

    if not chapter and not md_chapter:
        logger.info("No chapters specified to mark unavailable.")
        return

    if isinstance(chapter, Chapter):
        chapter = vars(chapter)
    chapters = [chapter] if not isinstance(chapter, list) else list(
        map(convert_model_dict, chapter)
    )

    if isinstance(md_chapter, dict):
        md_chapter = [md_chapter]

    now = get_current_datetime()

    for chap in chapters:
        chap["extension_name"] = extension_name
        chap["unavailable_at"] = now

    if isinstance(md_chapter, list):
        chapters.extend(
            [
                {
                    "chapter_lookup": now,
                    "chapter_timestamp": EXPIRE_TIME,
                    "chapter_language": md_chap["attributes"]["translatedLanguage"],
                    "chapter_title": md_chap["attributes"]["title"],
                    "chapter_number": md_chap["attributes"]["chapter"],
                    "chapter_volume": md_chap["attributes"].get("volume"),
                    "md_manga_id": md_manga_id,
                    "md_chapter_id": md_chap["id"],
                    "chapter_url": md_chap["attributes"]["externalUrl"],
                    "extension_name": extension_name,
                    "manga_name": mangadex_manga_data.get(md_manga_id, {}).get("title")
                    if isinstance(mangadex_manga_data, dict)
                    else None,
                    "unavailable_at": now,
                }
                for md_chap in md_chapter
            ]
        )

    chapters = [c for c in chapters if c.get("md_chapter_id")]
    if not chapters:
        logger.info("Nothing to enqueue in to_unavailable (missing md_chapter_id).")
        return

    try:
        upsert_result = database_connection["to_unavailable"].bulk_write(
            [
                UpdateOne(
                    {"md_chapter_id": {"$eq": chap["md_chapter_id"]}},
                    {"$set": chap},
                    upsert=True,
                )
                for chap in chapters
            ]
        )
    except pymongo.errors.BulkWriteError:
        traceback.print_exc()
        logger.exception(
            f"{mark_chapters_unavailable.__name__} raised an error when bulk writing to 'to_unavailable'."
        )
        return

    logger.info(
        f"Queued {upsert_result.upserted_count + upsert_result.modified_count} "
        "chapters for marking unavailable."
    )

    # Pull these chapters out of the live `uploaded` collection — the worker
    # will move them into `unavailable` once the MD-side edit succeeds.
    try:
        database_connection["uploaded"].bulk_write(
            [
                DeleteOne({"md_chapter_id": {"$eq": chap["md_chapter_id"]}})
                for chap in chapters
            ]
        )
    except pymongo.errors.BulkWriteError:
        traceback.print_exc()
        logger.exception(
            f"{mark_chapters_unavailable.__name__} raised an error when removing from 'uploaded'."
        )


def enqueue_chapter_removal(
    database_connection,
    extension_name: str,
    md_manga_id: str,
    md_chapter=None,
    chapter=None,
    mangadex_manga_data=None,
    extension=None,
    mode: str = None,
    **kwargs,
):
    """Route a removed chapter to the unavailable-queue or the hard-delete queue.

    Resolution order for `mode`: explicit arg > extension override >
    StateStore global setting > DEFAULT_REMOVAL_MODE. See
    `publoader.state.store.resolve_chapter_removal_mode`.
    """
    from publoader.state.store import (
        REMOVAL_MODE_DELETE,
        VALID_REMOVAL_MODES,
        resolve_chapter_removal_mode,
    )

    effective = mode if mode in VALID_REMOVAL_MODES else resolve_chapter_removal_mode(extension)

    if effective == REMOVAL_MODE_DELETE:
        return update_expired_chapter_database(
            database_connection=database_connection,
            extension_name=extension_name,
            md_manga_id=md_manga_id,
            md_chapter=md_chapter,
            chapter=chapter,
            mangadex_manga_data=mangadex_manga_data,
            **kwargs,
        )
    return mark_chapters_unavailable(
        database_connection=database_connection,
        extension_name=extension_name,
        md_manga_id=md_manga_id,
        md_chapter=md_chapter,
        chapter=chapter,
        mangadex_manga_data=mangadex_manga_data,
        **kwargs,
    )
