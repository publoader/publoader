import argparse
import logging
import traceback
from typing import List

from publoader.webhook import PubloaderWebhook
from publoader.workers import worker
from publoader.dupes_checker import DeleteDuplicatesMD
from publoader.extension_uploader import ExtensionUploader
from publoader.load_extensions import (
    load_extensions,
    run_extensions,
)
from publoader.utils.config import config, resources_path
from publoader.models.database import (
    get_database_connection,
)
from publoader.models.dataclasses import Chapter
from publoader.utils.utils import get_current_datetime, open_manga_data

logger = logging.getLogger("publoader")


def send_untracked_manga_webhook(extension_name, untracked_manga):
    logger.info(
        f"Found {len(untracked_manga)} untracked manga for {extension_name}: {untracked_manga}."
    )
    for untracked in untracked_manga:
        print(f"Found untracked manga {untracked.manga_id}: {untracked.manga_name}")

    if untracked_manga:
        split_series = [
            untracked_manga[elem : elem + 30]
            for elem in range(0, len(untracked_manga), 30)
        ]

        for count, series_list in enumerate(split_series, start=1):
            PubloaderWebhook(
                extension_name=extension_name,
                title=f"{len(untracked_manga)} Untracked Manga"
                + (f" ({count})" if count > 1 else ""),
                description="\n".join(
                    [
                        f"**{manga.manga_name}** ({manga.manga_language}): [{manga.manga_id}]({manga.manga_url})"
                        for manga in series_list
                    ]
                ),
                footer={"text": f"extensions.{extension_name}"},
            ).send()


def run_updates(
    database_connection,
    extension_data: dict,
    manga_data_local: dict,
):
    logger.info(f"Getting updates for {extension_data['name']}")

    extension = extension_data["extension"]
    extension_name = extension_data["name"]
    normalised_extension_name = extension_data["normalised_extension_name"]
    updated_chapters = extension_data["updated_chapters"]
    all_chapters = extension_data["all_chapters"]
    untracked_manga = extension_data["untracked_manga"]
    tracked_mangadex_ids = extension_data["tracked_mangadex_ids"]
    mangadex_group_id = extension_data["mangadex_group_id"]
    override_options = extension_data["override_options"]
    extension_languages = extension_data["extension_languages"]
    clean_db = extension_data["clean_db"]

    try:
        send_untracked_manga_webhook(extension_name, untracked_manga)

        if not updated_chapters:
            print(f"No new updates found for {normalised_extension_name}")
            PubloaderWebhook(
                extension_name,
                title=f"No new updates found for {extension_name}",
            ).send()
            return False

        updated_chapters[:] = [x for x in updated_chapters if x.md_manga_id]
        for update in updated_chapters:
            print(
                f"--Found manga {update.manga_name} - {update.manga_id}, "
                f"chapter_id: {update.chapter_id}, "
                f"chapter: {update.chapter_number!r}, "
                f"language: {update.chapter_language!r}, "
                f"title: {update.chapter_title!r}."
            )
            update.extension_name = extension_name
            update.chapter_lookup = get_current_datetime()

        print(f"Found {len(updated_chapters)} chapters for {normalised_extension_name}")
        PubloaderWebhook(
            extension_name,
            title=f"Found {len(updated_chapters)} chapters for {normalised_extension_name}",
        ).send()

        # Get already posted chapters for the extension
        posted_chapters_data = list(
            database_connection["uploaded"].find(
                {"extension_name": {"$eq": extension_name}}
            )
        )

        posted_chapters_data = [Chapter(**data) for data in posted_chapters_data]
        logger.info("Retrieved posted chapters from database.")

        ExtensionUploader(
            database_connection=database_connection,
            config=config,
            extension=extension_data,
            extension_name=extension_name,
            updates=updated_chapters,
            all_chapters=all_chapters,
            untracked_manga=untracked_manga,
            tracked_mangadex_ids=tracked_mangadex_ids,
            mangadex_group_id=mangadex_group_id,
            override_options=override_options,
            extension_languages=extension_languages,
            clean_db=clean_db,
            chapters_on_db=posted_chapters_data,
            manga_data_local=manga_data_local,
        ).upload_chapters()

        print(
            f"Uploaded all chapters for {normalised_extension_name} at {get_current_datetime()}."
        )

        if clean_db:
            mangadex_manga_ids_for_dupe_remove = tracked_mangadex_ids
        else:
            mangadex_manga_ids_for_dupe_remove = (
                [x.md_manga_id for x in updated_chapters]
                if updated_chapters
                else tracked_mangadex_ids
            )

        dupes_deleter = DeleteDuplicatesMD(
            database_connection=database_connection,
            extension_name=extension_name,
            tracked_mangadex_ids=mangadex_manga_ids_for_dupe_remove,
            manga_data_local=manga_data_local,
            extension_languages=extension_languages,
            mangadex_group_id=mangadex_group_id,
            override_options=override_options,
        )
        dupes_deleter.delete_dupes()
        return True
    except BaseException as e:
        traceback.print_exc()
        logger.exception(f"{normalised_extension_name} raised an error.")

        PubloaderWebhook(
            extension_name=extension_name,
            title=f"Error in {normalised_extension_name}",
            description=f"An exception occurred:\n```\n{str(e)}\n```",
            colour="FF0000",
        ).send()

        return False


def open_extensions(
    database_connection,
    names: List[str] = None,
    clean_db: bool = False,
    general_run: bool = False,
):
    """Run multiple extensions."""
    try:
        extensions_data = load_extensions(names, clean_db, general_run)
        if not extensions_data:
            return

        if clean_db:
            PubloaderWebhook(
                extension_name=None, title="Bot Clean Run Cycle", colour="256ef5"
            ).send()

        extensions = run_extensions(database_connection, extensions_data, clean_db)
        if not extensions:
            return

        manga_data_local = open_manga_data(
            resources_path.joinpath(config["Paths"]["manga_data_path"])
        )
        for site in extensions:
            run_updates(
                database_connection,
                extensions[site],
                manga_data_local=manga_data_local,
            )
    except BaseException as e:
        traceback.print_exc()
        logger.exception(f"Error raised.")
        PubloaderWebhook(
            "publoader run",
            title="Critial Run Error",
            description=str(e),
            colour="FF0000",
        ).send()


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

    vargs = vars(parser.parse_args())
    database_connection = get_database_connection()

    try:
        worker.main(database_connection, restart_threads=False)

        if vargs["extension"] is None:
            extension_to_run = None
        else:
            extension_to_run = [
                str(extension).strip() for extension in vargs["extension"]
            ]

        open_extensions(
            database_connection=database_connection,
            names=extension_to_run,
            clean_db=vargs["clean"],
            general_run=vargs["force"],
        )
    except KeyboardInterrupt:
        worker.kill()
