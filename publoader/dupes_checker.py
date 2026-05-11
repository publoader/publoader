import logging
from datetime import datetime
from typing import Dict, List, Optional

from publoader.http import http_client
from publoader.http.properties import RequestError
from publoader.models.database import update_expired_chapter_database
from publoader.utils.config import mangadex_api_url
from publoader.utils.misc import (
    check_chapter_url_same,
    fetch_aggregate,
    format_title,
    get_md_api,
    iter_aggregate_chapters,
)
from publoader.webhook import PubloaderDupesWebhook

logger = logging.getLogger("publoader")


class DeleteDuplicatesMD:
    def __init__(
        self,
        database_connection,
        extension_name: str,
        tracked_mangadex_ids: List[str],
        manga_data_local: Dict[str, dict],
        extension_languages: List[str],
        mangadex_group_id: str,
        override_options: dict,
    ) -> None:
        self.database_connection = database_connection
        self.extension_name = extension_name
        self.tracked_mangadex_ids = tracked_mangadex_ids
        self.manga_data_local = manga_data_local
        self.languages = list(set(extension_languages))
        self.mangadex_group_id = mangadex_group_id
        self.override_options = override_options
        self.to_delete = []

    def check_count(self, aggregate_chapters: dict) -> List[dict]:
        to_check = []
        for chapter in iter_aggregate_chapters(aggregate_chapters):
            to_check.append(chapter)
        return to_check

    def fetch_chapters(self, chapters: List[str]) -> Optional[List[dict]]:
        logger.debug(f"Getting chapter data for chapter ids: {chapters}")
        try:
            chapters_response = http_client.get(
                f"{mangadex_api_url}/chapter",
                params={"ids[]": chapters, "limit": 100, "includes[]": ["manga"]},
            )
        except RequestError as e:
            logger.error(e)
            return

        if (
            chapters_response.status_code in range(200, 300)
            and chapters_response.data is not None
        ):
            return chapters_response.data["data"]

    def sort_manga_data(self, chapters: list):
        chapter = chapters[0]

        manga = [m for m in chapter["relationships"] if m["type"] == "manga"][0]
        manga_id = manga["id"]
        manga_title = format_title(manga)

        return {manga_id: {"id": manga_id, "title": manga_title}}

    def check_chapters(
        self,
        chapters: List[dict],
        dupes_webhook: "PubloaderDupesWebhook",
    ) -> Optional[List[dict]]:
        # Chapters that are from the extension's group
        chapters_to_check = [
            chapter
            for chapter in chapters
            if self.mangadex_group_id
            in [
                g["id"]
                for g in chapter["relationships"]
                if g["type"] == "scanlation_group"
            ]
            and chapter["attributes"]["externalUrl"]
        ]

        # No chapters found
        if len(chapters_to_check) <= 1:
            return

        not_dupe = []
        dupes = []

        for chapter in chapters_to_check:
            external_url = chapter["attributes"]["externalUrl"]

            # Chapters with the *exact* same external url. Using str equality
            # because the previous regex match treated URLs as patterns, so
            # dots/slashes silently became metacharacters and matched too much.
            match_list = [
                other
                for other in not_dupe
                if other["attributes"]["externalUrl"] == external_url
            ]

            # Add both search term and search results to list
            if match_list:
                dupes.extend([chapter, *match_list])
            else:
                not_dupe.append(chapter)

        dupes_unique_external_url = {x["attributes"]["externalUrl"] for x in dupes}

        # Create sublists of identical external urls
        to_check = [
            [d for d in dupes if d["attributes"]["externalUrl"] == y]
            for y in dupes_unique_external_url
        ]

        checked_to_remove = []
        for unsorted_dupes in to_check:
            # Sort sublist by ascending timestamp
            sorted_chapters = sorted(
                unsorted_dupes,
                key=lambda chap_timestamp: datetime.strptime(
                    chap_timestamp["attributes"]["createdAt"], "%Y-%m-%dT%H:%M:%S%z"
                ),
            )

            chapters_to_remove = []

            # Create list of external ids that have multiple chapters associated
            # Loop through list of known external multi chapter id to loop through
            # list of sorted chapters if they contain an id of the known multi chapters
            multi_chapter_chapters = [
                {"external_chapter_id": multi_chapter_id, "chapter_to_check": x}
                for multi_chapter_id in self.override_options.get("multi_chapters", {})
                for x in list(
                    filter(
                        lambda y: (
                            y
                            if check_chapter_url_same(
                                y["attributes"]["externalUrl"], multi_chapter_id
                            )
                            else None
                        ),
                        sorted_chapters,
                    ),
                )
            ]

            # Filter out elements from the sorted chapters not present in multi-chapters list
            single_chapter_chapters = [
                x
                for x in sorted_chapters
                if x not in [y["chapter_to_check"] for y in multi_chapter_chapters]
            ]

            multi_chapter_chapters_not_remove = []

            # Loop through the multi-chapter list and keep minimum the oldest
            # md chapter object for the different chapter numbers listed for
            # known multi-chapter ids
            for multi_chap_obj in multi_chapter_chapters:
                multi_chapter_id = multi_chap_obj["external_chapter_id"]
                chap = multi_chap_obj["chapter_to_check"]
                if chap["attributes"]["chapter"] in self.override_options.get(
                    "multi_chapters", {}
                ).get(multi_chapter_id, []):
                    for not_remove_chap in self.override_options.get(
                        "multi_chapters", {}
                    ).get(multi_chapter_id, []):
                        # Don't add duplicate numbers to the list if they exist
                        if not_remove_chap not in [
                            x["attributes"]["chapter"]
                            for x in multi_chapter_chapters_not_remove
                        ]:
                            multi_chapter_chapters_not_remove.append(chap)

            # List of multi chapters to remove if they don't exist in the
            # multi-chapters not remove list
            chapters_to_remove = [
                chap["chapter_to_check"]
                for chap in multi_chapter_chapters
                if chap["chapter_to_check"] not in multi_chapter_chapters_not_remove
            ]

            # Add all the dupes from the first (oldest) element onwards
            chapters_to_remove.extend(single_chapter_chapters[1:])
            checked_to_remove.extend(chapters_to_remove)

        if checked_to_remove:
            dupes_webhook.add_chapter(checked_to_remove)
            logger.info(
                f"Found dupes to delete: {[x['id'] for x in checked_to_remove]}"
            )
        return checked_to_remove

    def sort_chapters(self, chapters: list):
        sorted_chapters = {}
        for chapter in chapters:
            chapter_language = chapter["attributes"]["translatedLanguage"]
            if chapter_language not in sorted_chapters:
                sorted_chapters[chapter_language] = [chapter]
            else:
                sorted_chapters[chapter_language].append(chapter)
        return sorted_chapters

    def delete_dupes(self):
        print("Looking for chapter dupes.")

        for mang_index, manga_id in enumerate(set(self.tracked_mangadex_ids), start=1):
            manga_data = self.manga_data_local.get(manga_id)
            dupes_webhook = PubloaderDupesWebhook(self.extension_name, manga_data)
            dupes_found = False

            logger.info(
                f"Getting aggregate info for extensions.{self.extension_name} manga {manga_id} in languages {self.languages}."
            )
            aggregate_chapters_all_langs_unchecked = fetch_aggregate(
                http_client,
                manga_id,
                **{
                    "translatedLanguage[]": self.languages,
                    "groups[]": [self.mangadex_group_id],
                },
            )
            if aggregate_chapters_all_langs_unchecked is None:
                logger.info(
                    f"Aggregate fetching for extensions.{self.extension_name} manga {manga_id} returned null."
                )
                continue

            logger.debug(
                f"Checking which chapters have more than one of the same number chapters."
            )
            aggregate_chapters_all_langs_checked = self.check_count(
                aggregate_chapters_all_langs_unchecked
            )

            main_chapters = [
                chapter["id"] for chapter in aggregate_chapters_all_langs_checked
            ]
            other_chapters = []
            for chapter in aggregate_chapters_all_langs_checked:
                other_chapters.extend(chapter["others"])

            all_chapter_ids_unsorted = [*main_chapters, *other_chapters]
            all_chapter_ids_unsorted_split = [
                all_chapter_ids_unsorted[elem : elem + 100]
                for elem in range(0, len(all_chapter_ids_unsorted), 100)
            ]

            logger.debug(f"Getting chapter data for chapters with more than one count.")

            chapters_md_unsorted = []
            for chapter_chunk in all_chapter_ids_unsorted_split:
                chapters_md_unsorted.extend(
                    get_md_api(
                        "chapter", **{"ids[]": chapter_chunk, "includes[]": ["manga"]}
                    )
                )

            if not chapters_md_unsorted:
                logger.info(
                    f"No unsorted chapters found for {manga_id} in languages {self.languages}"
                )
                continue

            if not dupes_webhook.manga:
                manga_data = self.sort_manga_data(chapters_md_unsorted)
                dupes_webhook.init_manga(manga_data)

            chapters_to_delete = self.check_chapters(
                chapters_md_unsorted, dupes_webhook
            )

            if not chapters_to_delete:
                continue

            logger.debug(f"Found dupes in manga {manga_id}")
            dupes_found = True

            update_expired_chapter_database(
                database_connection=self.database_connection,
                extension_name=self.extension_name,
                md_chapter=chapters_to_delete,
                md_manga_id=manga_id,
                mangadex_manga_data=self.manga_data_local,
            )

            if not dupes_found:
                print(f"Didn't find any dupes in manga: {manga_id}")
            else:
                print(f"--Found dupes in manga: {manga_id}")

            dupes_webhook.main()

        print("Finished looking for chapter dupes.")
