"""Worker that processes the `to_unavailable` queue.

For each chapter:
  1. Fetch the current chapter from MangaDex so we know its version, groups,
     language, etc.
  2. PUT /chapter/{id} with the same payload minus `externalUrl` (and bump
     version). The chapter card image uploaded at initial upload stays as
     the visible content.
  3. On success, archive the row in the `unavailable` collection and remove
     it from `to_unavailable`.

Failures are left on the queue so they retry on the next scheduler tick.
"""
import logging
from typing import Optional

from publoader.http.properties import RequestError
from publoader.models.dataclasses import Chapter
from publoader.utils.config import mangadex_api_url
from publoader.utils.utils import get_current_datetime

logger = logging.getLogger("publoader-unavailable")


class UnavailableProcess:
    def __init__(self, item: dict, http_client, **kwargs):
        self.item = item
        self.http_client = http_client
        self.md_chapter_id: Optional[str] = item.get("md_chapter_id")
        self.chapter = Chapter(
            **{
                k: v
                for k, v in item.items()
                if k in Chapter.__dataclass_fields__
            }
        )

    def _fetch_md_chapter(self):
        try:
            resp = self.http_client.get(
                f"{mangadex_api_url}/chapter/{self.md_chapter_id}",
                params={"includes[]": ["scanlation_group"]},
                successful_codes=[404],
            )
        except RequestError as e:
            logger.error(f"Couldn't fetch chapter {self.md_chapter_id}: {e}")
            return None

        if resp.status_code == 404 or resp.data is None:
            return None
        if resp.status_code != 200:
            return None
        return resp.data.get("data")

    def mark_unavailable(self) -> bool:
        if not self.md_chapter_id:
            logger.error(f"Missing md_chapter_id on unavailable row: {self.item}")
            return False

        chapter_data = self._fetch_md_chapter()
        if chapter_data is None:
            # Either gone from MD already (treat as success → archive) or a
            # transient fetch failure. Distinguish via a follow-up HEAD-ish
            # probe so we don't archive on transient errors.
            try:
                probe = self.http_client.get(
                    f"{mangadex_api_url}/chapter/{self.md_chapter_id}",
                    successful_codes=[404],
                    tries=1,
                )
            except RequestError:
                return False
            if probe.status_code == 404:
                logger.info(
                    f"Chapter {self.md_chapter_id} already gone from MD; archiving."
                )
                return True
            return False

        attrs = chapter_data.get("attributes") or {}
        if not attrs.get("externalUrl"):
            # Already cleared (maybe a re-run). Treat as success.
            logger.info(
                f"Chapter {self.md_chapter_id} already has no externalUrl; archiving."
            )
            return True

        payload = {
            "volume": attrs.get("volume"),
            "chapter": attrs.get("chapter"),
            "title": attrs.get("title"),
            "translatedLanguage": attrs.get("translatedLanguage"),
            "externalUrl": None,  # strip the source link
            "version": attrs.get("version"),
            "groups": [
                rel["id"]
                for rel in chapter_data.get("relationships", [])
                if rel.get("type") == "scanlation_group"
            ],
        }

        try:
            resp = self.http_client.put(
                f"{mangadex_api_url}/chapter/{self.md_chapter_id}", json=payload
            )
        except RequestError as e:
            logger.error(f"Couldn't edit chapter {self.md_chapter_id}: {e}")
            return False

        if resp.status_code != 200:
            logger.error(
                f"Edit returned {resp.status_code} for chapter {self.md_chapter_id}"
            )
            return False

        logger.info(
            f"Marked chapter {self.md_chapter_id} unavailable "
            f"(extension={self.chapter.extension_name})."
        )
        return True


def run(item, http_client, queue_webhook, database_connection, **kwargs):
    proc = UnavailableProcess(item, http_client)
    success = proc.mark_unavailable()
    queue_webhook.add_chapter(item, processed=success)

    if not success:
        return

    # Archive the row before clearing it from the queue.
    archive_doc = dict(item)
    archive_doc.pop("_id", None)
    archive_doc["archived_at"] = get_current_datetime()
    try:
        database_connection["unavailable"].insert_one(archive_doc)
    except Exception:
        logger.exception(
            f"Failed to archive chapter {item.get('md_chapter_id')} into 'unavailable'"
        )
        return

    database_connection["to_unavailable"].delete_one({"_id": item["_id"]})


def fetch_data_from_database(database_connection):
    return list(database_connection["to_unavailable"].find())
