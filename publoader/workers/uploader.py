import logging
import time
from collections import deque
from typing import Dict, List, Optional

import natsort
import gridfs
from gridfs import GridOut

from publoader.http.properties import RequestError
from publoader.models.database import (
    update_database,
)
from publoader.models.dataclasses import Chapter
from publoader.utils.config import (
    md_upload_api_url,
    ratelimit_time,
    upload_retry,
)
from publoader.utils.misc import flatten, get_md_api
from publoader.webhook import PubloaderNotIndexedWebhook

logger = logging.getLogger("publoader-uploader")

uploaded_list = deque()


class UploaderProcess:
    def __init__(
        self,
        upload_chapter: dict,
        http_client,
        images: list,
        **kwargs,
    ):
        upload_chapter.pop("images")
        self.chapter = Chapter(**upload_chapter)
        self.http_client = http_client
        self.extension_name = self.chapter.extension_name
        self.mangadex_manga_id = upload_chapter.get("mangadex_manga_id", "")
        self.mangadex_group_id = upload_chapter.get("mangadex_group_id", "")
        self.image_ids = images
        self.image_ids_str = [str(img._id) for img in self.image_ids]

        self.manga_generic_error_message = (
            f"Extension: {self.extension_name}, "
            f"Manga: {self.chapter.manga_name}, "
            f"{self.mangadex_manga_id} - {self.chapter.manga_id}, "
            f"chapter: {self.chapter.chapter_id}, "
            f"number: {self.chapter.chapter_number!r}, "
            f"volume: {self.chapter.chapter_volume!r}, "
            f"language: {self.chapter.chapter_language!r}, "
            f"title: {self.chapter.chapter_title!r}"
        )

        self.upload_retry_total = upload_retry
        self.images_upload_session = 10
        self.uploaded_image_ids_by_index: Dict[int, str] = {}
        self.images_to_upload_names = {}
        self.upload_session_id: Optional[str] = None
        self.failed_image_upload = False
        self.successful_upload_id: Optional[str] = None

    @property
    def images_to_upload_ids(self) -> List[str]:
        return [
            self.uploaded_image_ids_by_index[i]
            for i in sorted(self.uploaded_image_ids_by_index)
        ]

    def _images_upload(self, image_batch: Dict[str, bytes]):
        """Upload the images"""
        try:
            image_upload_response = self.http_client.post(
                f"{md_upload_api_url}/{self.upload_session_id}",
                files=image_batch,
            )
        except (RequestError,) as e:
            logger.error(e)
            return

        # Some images returned errors
        uploaded_image_data = image_upload_response.data
        successful_upload_data = uploaded_image_data["data"]
        if uploaded_image_data["errors"] or uploaded_image_data["result"] == "error":
            logger.warning(f"Some images errored out.")
            return
        return successful_upload_data

    def _upload_images(self, image_batch: Dict[str, bytes]) -> bool:
        """Try to upload every 10 (default) images to the upload session."""
        # No images to upload
        if not image_batch:
            return True

        successful_upload_message = "Success: Uploaded page {}, size: {} bytes."

        image_batch_list = list(image_batch.keys())
        print(
            f"Uploading images {int(image_batch_list[0]) + 1} to "
            f"{int(image_batch_list[-1]) + 1}."
        )
        logger.debug(
            f"Uploading images {int(image_batch_list[0]) + 1} to "
            f"{int(image_batch_list[-1]) + 1}."
        )

        self.failed_image_upload = True
        for retry in range(upload_retry):
            successful_upload_data = self._images_upload(image_batch)

            if not successful_upload_data:
                logger.warning("Image upload returned no data, retrying.")
                continue

            logger.info(f"Success: Uploaded images {successful_upload_data}")

            for uploaded_image in successful_upload_data:
                uploaded_image_attributes = uploaded_image["attributes"]
                uploaded_filename = uploaded_image_attributes["originalFileName"]
                file_size = uploaded_image_attributes["fileSize"]

                self.uploaded_image_ids_by_index[int(uploaded_filename)] = (
                    uploaded_image["id"]
                )
                original_filename = self.images_to_upload_names[uploaded_filename]

                print(successful_upload_message.format(original_filename, file_size))

            # Length of images array returned from the api is the same as the array
            # sent to the api
            if len(successful_upload_data) == len(image_batch):
                logger.info(
                    f"Uploaded images {int(image_batch_list[0]) + 1} to "
                    f"{int(image_batch_list[-1]) + 1}."
                )
                self.failed_image_upload = False
                break

            # Update the images to upload dictionary with the images that failed
            already_uploaded = {
                i["attributes"]["originalFileName"] for i in successful_upload_data
            }
            image_batch = {
                k: v for (k, v) in image_batch.items() if k not in already_uploaded
            }
            logger.warning(
                f"Some images didn't upload, retrying. Failed images: {list(image_batch.keys())}"
            )

        return self.failed_image_upload

    def get_images_to_upload(self, images_to_read: List[GridOut]) -> Dict[str, bytes]:
        """Read the image data from the zip as list."""
        logger.info(
            f"Reading data for images: {[img.filename for img in images_to_read]}"
        )
        # Dictionary to store the image index to the image bytes
        files: Dict[str, bytes] = {}
        for array_index, image in enumerate(images_to_read, start=1):
            # Get index of the image in the images array
            renamed_file = str(self.image_ids_str.index(str(image._id)))
            # Keeps track of which image index belongs to which image name
            self.images_to_upload_names.update({renamed_file: image.filename})
            files.update({renamed_file: image.read()})
        return files

    def remove_upload_session(self, session_id: Optional[str] = None):
        """Delete the upload session."""
        if session_id is None:
            session_id = self.upload_session_id

        try:
            self.http_client.delete(
                f"{md_upload_api_url}/{session_id}",
                successful_codes=[404],
            )
        except RequestError as e:
            logger.error(e)
        logger.info(f"Sent {session_id} to be deleted.")

    def _delete_existing_upload_session(self):
        """Remove any exising upload sessions to not error out as mangadex only allows one upload session at a time."""
        logger.debug(
            f"Checking for upload sessions for manga {self.mangadex_manga_id}, chapter {self.chapter}."
        )

        try:
            existing_session = self.http_client.get(
                f"{md_upload_api_url}", successful_codes=[404]
            )
        except RequestError as e:
            logger.error(e)
        else:
            if (
                existing_session.status_code == 200
                and existing_session.data is not None
            ):
                logger.debug(f"Existing upload session data: {existing_session.data}")
                self.remove_upload_session(existing_session.data["data"]["id"])
                return
            elif existing_session.status_code == 404:
                return

        logger.error("Exising upload session not deleted.")
        raise Exception(f"Couldn't delete existing upload session.")

    def _create_upload_session(self) -> Optional[dict]:
        """Try to create an upload session 3 times."""
        try:
            self._delete_existing_upload_session()
        except Exception as e:
            logger.error(e)
        else:
            # Start the upload session
            try:
                upload_session_response = self.http_client.post(
                    f"{md_upload_api_url}/begin",
                    json={
                        "manga": self.mangadex_manga_id,
                        "groups": [self.mangadex_group_id],
                    },
                    tries=1,
                )
            except (RequestError,) as e:
                logger.error(e)
            else:
                if upload_session_response.ok:
                    return upload_session_response.data

        # Couldn't create an upload session, skip the chapter
        upload_session_response_json_message = (
            f"Couldn't create an upload session for "
            f"{self.manga_generic_error_message}."
        )
        logger.error(f"{upload_session_response_json_message} {self.chapter}")
        print(f"{upload_session_response_json_message}")
        return

    def _commit_chapter(self) -> bool:
        """Try commit the chapter to mangadex."""
        payload = {
            "chapterDraft": {
                "volume": self.chapter.chapter_volume,
                "chapter": self.chapter.chapter_number,
                "title": self.chapter.chapter_title,
                "translatedLanguage": self.chapter.chapter_language,
                "externalUrl": self.chapter.chapter_url,
            },
            "pageOrder": (
                self.images_to_upload_ids if not self.failed_image_upload else []
            ),
            "termsAccepted": True,
        }

        # if (
        #     self.chapter.chapter_expire is not None
        #     and self.chapter.chapter_expire > datetime.now()
        # ):
        #     payload["chapterDraft"]["publishAt"] = self.chapter.chapter_expire.strftime(
        #         "%Y-%m-%dT%H:%M:%S"
        #     )

        logger.info(f"Commit payload: {payload}")

        try:
            chapter_commit_response = self.http_client.post(
                f"{md_upload_api_url}/{self.upload_session_id}/commit",
                json=payload,
            )
        except RequestError as e:
            logger.error(e)
            return False

        if chapter_commit_response.status_code == 200:
            if chapter_commit_response.data is not None:
                self.successful_upload_id = chapter_commit_response.data["data"]["id"]
                self.chapter.md_chapter_id = self.successful_upload_id

                successful_upload_message = f"Committed {self.successful_upload_id} - {self.chapter.chapter_id} for"
                logger.info(f"{successful_upload_message} {self.chapter}")
                print(f"{successful_upload_message} {self.manga_generic_error_message}")
                return True
            else:
                chapter_commit_response_json_message = f"Couldn't convert successful chapter commit api response into a json"
                logger.warning(
                    f"{chapter_commit_response_json_message} for {self.chapter}"
                )
                print(chapter_commit_response_json_message)
            return True

        logger.error(f"Couldn't commit {self.chapter}")
        print(
            f"Couldn't commit {self.upload_session_id}: {self.manga_generic_error_message}."
        )
        self.remove_upload_session()
        return False

    def start_upload(self) -> bool:
        upload_session_response_json = self._create_upload_session()
        if upload_session_response_json is None:
            return False

        self.upload_session_id = upload_session_response_json["data"]["id"]
        logger.info(
            f"Created upload session: {self.upload_session_id} - {self.chapter}"
        )

        if self.image_ids is not None and self.image_ids:
            valid_images_to_upload_names = [
                self.image_ids[l : l + self.images_upload_session]
                for l in range(0, len(self.image_ids), self.images_upload_session)
            ]
            print(f"{len(flatten(valid_images_to_upload_names))} images to upload.")

            for images_array in valid_images_to_upload_names:
                images_to_upload = self.get_images_to_upload(images_array)
                self._upload_images(images_to_upload)

                # Don't upload rest of the chapter's images if the images before failed
                if self.failed_image_upload:
                    break

        # Skip chapter upload and delete upload session
        if self.failed_image_upload:
            failed_image_upload_message = f"Couldn't upload images for {self.upload_session_id}: {self.manga_generic_error_message}."
            print(failed_image_upload_message)
            logger.error(f"{failed_image_upload_message} {self.chapter}")

        chapter_committed = self._commit_chapter()
        if not chapter_committed:
            self.remove_upload_session()
            return False
        return True


def run(item, http_client, queue_webhook, database_connection, **kwargs):
    if "images" in item:
        image_filestream = gridfs.GridFS(database_connection, "images")
        images = image_filestream.find({"_id": {"$in": item["images"]}})
        image_ids = list(natsort.natsorted(images, key=lambda x: x.filename))
    else:
        images = []
        image_ids = []

    chapter_uploader = UploaderProcess(item, http_client, image_ids)
    uploaded = chapter_uploader.start_upload()

    successful_upload_id = chapter_uploader.successful_upload_id
    item["md_chapter_id"] = successful_upload_id

    queue_webhook.add_chapter(item, processed=uploaded)

    if uploaded:
        database_connection["to_upload"].delete_one({"_id": {"$eq": item["_id"]}})

        if images:
            database_connection["images.files"].delete_many(
                {"_id": {"$in": [img._id for img in image_ids]}}
            )
            database_connection["images.chunks"].delete_many(
                {"files_id": {"$in": [img._id for img in image_ids]}}
            )

        if successful_upload_id is not None:
            uploaded_list.append(successful_upload_id)
            update_database(database_connection, item)


def fetch_data_from_database(database_connection):
    return [chapter for chapter in database_connection["to_upload"].find()]


def check_all_chapters_uploaded():
    """Check if all the chapters uploaded to MangaDex were indexed correctly."""
    logger.info(
        "Checking if all currently uploaded chapters are available on MangaDex."
    )
    print("Checking which chapters weren't indexed.")
    chapters_on_md = []

    # if self.clean_db:
    #     uploaded_chapter_ids.extend(
    #         [
    #             chapter.md_chapter_id
    #             for chapter in self.chapters_on_db
    #             if chapter.chapter_expire
    #             >= get_current_datetime()
    #             and chapter.md_chapter_id. is not None
    #         ]
    #     )

    uploaded_chapter_ids = list(set(uploaded_list))
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

        chapters_indexed = [
            chapter_id
            for chapter_id in uploaded_chapter_ids
            if chapter_id not in chapters_not_on_md
        ]

        logger.info(f"Chapters not indexed: {chapters_not_on_md}")
        PubloaderNotIndexedWebhook(
            None,
            chapters_not_indexed=chapters_not_on_md,
            chapters_indexed=len(chapters_indexed),
        ).main()
    else:
        logger.info("No uploaded chapter mangadex ids.")

    uploaded_list.clear()
