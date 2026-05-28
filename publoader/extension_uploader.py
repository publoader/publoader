import configparser
import json
import logging
import time
from typing import Dict, List, Optional

from publoader.manga_uploader import MangaUploaderProcess
from publoader.models.database import enqueue_chapter_removal
from publoader.models.dataclasses import Chapter, Manga
from publoader.utils.config import ratelimit_time, resources_path
from publoader.utils.misc import format_title, get_md_api
from publoader.utils.utils import atomic_write_text
from publoader.webhook import PubloaderNotIndexedWebhook, PubloaderWebhook

logger = logging.getLogger("publoader")


class ExtensionUploader:
    def __init__(
        self,
        database_connection,
        config: configparser.RawConfigParser,
        extension,
        extension_name: str,
        updates: List[Chapter],
        all_chapters: Optional[List[Chapter]],
        untracked_manga: List[Manga],
        tracked_mangadex_ids: List[str],
        mangadex_group_id: str,
        override_options: dict,
        extension_languages: list[str],
        clean_db: bool,
        chapters_on_db: List[Chapter],
        manga_data_local: Dict[str, dict],
        removal_mode: Optional[str] = None,
    ):
        self.database_connection = database_connection
        self.config = config
        self.extension = extension
        self.clean_db = clean_db
        self.removal_mode = removal_mode
        self.chapters_on_db = chapters_on_db
        self.manga_data_local = manga_data_local

        self.updates = updates
        self.extension_name = extension_name
        self.all_chapters = all_chapters
        self.untracked_manga = untracked_manga
        self.tracked_mangadex_ids = tracked_mangadex_ids
        self.override_options = override_options
        self.mangadex_group_id = mangadex_group_id
        self.extension_languages = extension_languages

        self.same_chapter_dict: Dict[str, List[str]] = self.override_options.get(
            "same", {}
        )

        self.current_uploaded_chapters: List[Chapter] = []
        self._get_manga_data_md()

        self.updated_manga_chapters = self._sort_chapters_by_manga(self.updates)
        self.all_manga_chapters = self._sort_chapters_by_manga(self.all_chapters)
        self.chapters_on_md = []

        self.chapters_for_upload: List[Chapter] = []
        self.chapters_for_skipping: List[Chapter] = []
        self.chapters_for_editing: List[Chapter] = []

    def _get_external_chapters_md(self, manga_ids) -> Dict[str, List[dict]]:
        """Get the chapter data of the passed manga ids."""
        logger.debug(
            f"Getting {self.extension_name}'s uploaded chapters for series: {manga_ids}"
        )
        print(f"Getting {self.extension_name} chapters on mangadex for certain series.")
        chapters_sorted = {}
        for manga_id in set(manga_ids):
            chapters_sorted[manga_id] = get_md_api(
                "chapter",
                **{
                    "groups[]": [self.mangadex_group_id],
                    "order[createdAt]": "desc",
                    "manga": manga_id,
                },
            )
        return chapters_sorted

    def _extension_instance(self):
        """ExtensionUploader is passed the whole `extension_data` dict as
        `extension`. The actual Extension instance is at ['extension'] — pull
        it out when we need the removal-mode override."""
        if isinstance(self.extension, dict):
            return self.extension.get("extension")
        return self.extension

    def find_untracked_md_manga(self):
        """Check if any series on MangaDex are not tracked."""
        manga_ids = set()

        for chapter in self.chapters_on_md:
            manga_id = [
                m["id"] for m in chapter["relationships"] if m["type"] == "manga"
            ][0]
            manga_ids.add(manga_id)

        manga_untracked = [
            m for m in list(manga_ids) if m not in self.tracked_mangadex_ids
        ]

        logger.info(f"Manga not tracked but on mangadex: {manga_untracked}")

        logger.info(
            f"{self.__class__.__name__} deleting chapters of series that don't exist on external, but do on MangaDex."
        )
        for manga_id in self.chapters_on_md:
            if manga_id in manga_untracked:
                enqueue_chapter_removal(
                    database_connection=self.database_connection,
                    extension_name=self.extension_name,
                    md_chapter=self.chapters_on_md[manga_id],
                    md_manga_id=manga_id,
                    mangadex_manga_data=self.manga_data_local,
                    extension=self._extension_instance(),
                    mode=self.removal_mode,
                )

    def remove_chapters_if_not_external(self):
        """Remove chapters on MangaDex if they are not on external."""
        if not self.clean_db:
            return
        if self.all_manga_chapters is None:
            return

        # missing_ids = list(
        #     set(self.updated_manga_chapters.keys()).difference(
        #         set(self.all_manga_chapters.keys())
        #     )
        # )

        # Manga ids of no chapters from tracked series in updates
        tracked_ids_no_chapters_external = [
            m
            for m in self.tracked_mangadex_ids
            if m not in self.all_manga_chapters.keys()
        ]

        # Chapters of tracked_ids_no_chapters_external, if id not available, no chapters
        tracked_ids_no_chapters_md = self._get_external_chapters_md(
            tracked_ids_no_chapters_external
        )

        # Manga ids of chapters from tracked series, chapters on md, no chapters in updates
        tracked_ids_chapters_md = [
            m
            for m in tracked_ids_no_chapters_external
            if m in tracked_ids_no_chapters_md.keys()
        ]

        logger.info(
            f"{self.__class__.__name__} deleting chapters on MangaDex, but not on external: {tracked_ids_chapters_md}"
        )

        for manga_id in tracked_ids_no_chapters_md:
            if manga_id in tracked_ids_chapters_md:
                enqueue_chapter_removal(
                    database_connection=self.database_connection,
                    extension_name=self.extension_name,
                    md_chapter=tracked_ids_no_chapters_md[manga_id],
                    md_manga_id=manga_id,
                    mangadex_manga_data=self.manga_data_local,
                    extension=self._extension_instance(),
                    mode=self.removal_mode,
                )

    def _get_manga_data_md(self) -> Dict[str, dict]:
        """Get the manga data from mangadex if needed and sort by manga id."""
        get_manga_data = []

        tracked_manga = self.tracked_mangadex_ids
        for tracked in tracked_manga:
            if tracked not in self.manga_data_local.keys():
                get_manga_data.append(tracked)

        if get_manga_data:
            tracked_manga_splice = [
                get_manga_data[elem : elem + 100]
                for elem in range(0, len(get_manga_data), 100)
            ]

            tracked_manga_data = []

            for manga_splice in tracked_manga_splice:
                tracked_manga_data.extend(
                    get_md_api(
                        "manga",
                        **{
                            "ids[]": manga_splice,
                            "order[createdAt]": "desc",
                        },
                    )
                )

            for manga in tracked_manga_data:
                manga_id = manga["id"]
                manga_title = format_title(manga)
                if manga_id not in self.manga_data_local:
                    self.manga_data_local.update(
                        {manga_id: {"id": manga_id, "title": manga_title}}
                    )

            atomic_write_text(
                resources_path.joinpath(self.config["Paths"]["manga_data_path"]),
                json.dumps(self.manga_data_local, indent=2),
            )

        return self.manga_data_local

    def _sort_chapters_by_manga(
        self, updates: List[Chapter]
    ) -> Optional[Dict[str, List[Chapter]]]:
        """Sort the chapters by manga id."""
        if updates is None:
            return None
        if not updates:
            return {}

        chapters_sorted = {}
        for chapter in updates:
            md_id = chapter.md_manga_id
            if not md_id:
                logger.warning(
                    f"No mangadex id found for {self.extension_name} id {chapter.manga_id}."
                )
                continue

            chapter.manga_name = (
                self.manga_data_local.get(md_id, {}).get("title")
                if self.manga_data_local.get(md_id, {}).get("title")
                else chapter.manga_name
            )

            try:
                chapters_sorted[md_id].append(chapter)
            except (KeyError, ValueError, AttributeError):
                chapters_sorted[md_id] = [chapter]

        if "None" in chapters_sorted:
            del chapters_sorted["None"]
        return chapters_sorted

    def _check_all_chapters_uploaded(self):
        """Check if all the chapters uploaded to MangaDex were indexed correctly."""
        logger.info(
            "Checking if all currently uploaded chapters are available on MangaDex."
        )
        print("Checking which chapters weren't indexed.")
        chapters_on_md = []

        uploaded_chapter_ids = [
            chapter.md_chapter_id
            for chapter in self.current_uploaded_chapters
            if chapter.md_chapter_id is not None
        ]

        uploaded_chapter_ids = list(set(uploaded_chapter_ids))
        if uploaded_chapter_ids:
            logger.info(f"Uploaded chapters mangadex ids: {uploaded_chapter_ids}")
            uploaded_chapter_ids_split = [
                uploaded_chapter_ids[elem : elem + 100]
                for elem in range(0, len(uploaded_chapter_ids), 100)
            ]

            time.sleep(ratelimit_time * 3)
            for uploaded_ids in uploaded_chapter_ids_split:
                chapters_on_md.extend(
                    get_md_api(
                        "chapter",
                        **{
                            "ids[]": uploaded_ids,
                            "order[createdAt]": "desc",
                            "includes[]": ["manga"],
                        },
                    )
                )

            chapters_not_on_md = [
                chapter_id
                for chapter_id in uploaded_chapter_ids
                if chapter_id not in [chapter["id"] for chapter in chapters_on_md]
            ]

            logger.info(f"Chapters not indexed: {chapters_not_on_md}")
            PubloaderNotIndexedWebhook(
                extension_name=self.extension_name,
                chapters_not_indexed=chapters_not_on_md,
                chapters_indexed=len(uploaded_chapter_ids) - len(chapters_not_on_md),
            ).main()
        else:
            logger.info("No uploaded chapter mangadex ids.")

    def upload_chapters(self):
        """Go through each new chapter and upload it to mangadex."""
        # Sort each chapter by manga
        for index, mangadex_manga_id in enumerate(self.updated_manga_chapters, start=1):
            all_chapters = None
            if self.all_manga_chapters is not None:
                all_chapters = self.all_manga_chapters.get(mangadex_manga_id, [])

            manga_uploader = MangaUploaderProcess(
                database_connection=self.database_connection,
                extension_name=self.extension_name,
                clean_db=self.clean_db,
                updated_chapters=self.updated_manga_chapters.get(mangadex_manga_id, []),
                all_manga_chapters=all_chapters,
                mangadex_manga_id=mangadex_manga_id,
                mangadex_group_id=self.mangadex_group_id,
                total_chapters_on_md=self.chapters_on_md,
                current_uploaded_chapters=self.current_uploaded_chapters,
                override_options=self.override_options,
                same_chapter_dict=self.same_chapter_dict,
                mangadex_manga_data=self.manga_data_local.get(mangadex_manga_id, {}),
                chapters_on_db=self.chapters_on_db,
                languages=self.extension_languages,
                chapters_for_upload=self.chapters_for_upload,
                chapters_for_skipping=self.chapters_for_skipping,
                chapters_for_editing=self.chapters_for_editing,
                extension=self._extension_instance(),
                removal_mode=self.removal_mode,
            )
            manga_uploader.start_manga_uploading_process(
                index == len(self.updated_manga_chapters)
            )

        if self.current_uploaded_chapters:
            self._check_all_chapters_uploaded()

        self.find_untracked_md_manga()
        self.remove_chapters_if_not_external()

        PubloaderWebhook(
            self.extension_name,
            title=f"{self.extension_name.title()} Updates",
            description=(
                f"To upload: {len(self.chapters_for_upload)}\n"
                f"To edit: {len(self.chapters_for_editing)}\n"
                f"Skipped: {len(self.chapters_for_skipping)}"
            ),
        ).send()
