import asyncio
import logging
import math
from datetime import datetime
from typing import Dict, List, Optional
from urllib.parse import urlparse

from publoader.http import http_client
from publoader.http.properties import RequestError
from publoader.utils.config import mangadex_api_url, upload_retry

logger = logging.getLogger("publoader")


def get_md_api(route: str, **params: dict) -> List[dict]:
    """Page through the MangaDex api and return the combined data array."""
    chapters: List[dict] = []
    limit = 100
    offset = 0
    retry = 0
    created_at_since_time = "2000-01-01T00:00:00"
    first_call = True
    parameters = dict(params)

    while retry < upload_retry:
        parameters.update(
            {
                "limit": limit,
                "offset": offset,
                "createdAtSince": created_at_since_time,
            }
        )

        logger.debug(f"Request parameters: {parameters}")

        try:
            response = http_client.get(
                f"{mangadex_api_url}/{route}", params=parameters
            )
        except RequestError as e:
            logger.error(e)
            retry += 1
            continue

        if response.status_code != 200 or response.data is None:
            logger.error(f"Couldn't fetch {route} page (status {response.status_code})")
            retry += 1
            continue

        page = response.data.get("data") or []
        chapters.extend(page)

        if first_call:
            pages = math.ceil(response.data.get("total", 0) / limit)
            logger.debug(f"{pages} page(s) for {route}.")
            first_call = False

        # Empty page => done
        if not page:
            break

        offset += limit

        # Mangadex caps offset at 10k. Reset using the last item's createdAt to
        # walk past the wall.
        if offset >= 10000:
            logger.debug(f"Reached 10k {route}s, continuing with createdAtSince cursor.")
            created_at_since_time = chapters[-1]["attributes"]["createdAt"].split("+")[0]
            offset = 0
            first_call = True

        retry = 0

    return sorted(
        chapters,
        key=lambda chap: datetime.strptime(
            chap["attributes"]["createdAt"], "%Y-%m-%dT%H:%M:%S%z"
        ),
    )


def iter_aggregate_chapters(aggregate_chapters):
    """Return a generator for each chapter object in the aggregate response."""
    if isinstance(aggregate_chapters, dict):
        volumes_iterable = aggregate_chapters.values()
    elif isinstance(aggregate_chapters, list):
        volumes_iterable = aggregate_chapters
    else:
        return

    for volume in volumes_iterable:
        chapters = volume.get("chapters") if isinstance(volume, dict) else None
        if not chapters:
            continue

        if isinstance(chapters, dict):
            yield from chapters.values()
        elif isinstance(chapters, list):
            yield from chapters


def fetch_aggregate(http_client, manga_id: str, **params) -> Optional[dict]:
    """Call the mangadex api to get the volumes of each chapter."""
    try:
        aggregate_response = http_client.get(
            f"{mangadex_api_url}/manga/{manga_id}/aggregate",
            params=params,
        )
    except RequestError as e:
        return

    if (
        aggregate_response.status_code in range(200, 300)
        and aggregate_response.data is not None
    ):
        return aggregate_response.data["volumes"]

    logger.error(f"Error returned from aggregate response for manga {manga_id}")


def flatten(t: List[list]) -> list:
    """Flatten nested lists into one list."""
    return [item for sublist in t for item in sublist]


def find_key_from_list_value(
    dict_to_search: Dict[str, List[str]], list_element: str
) -> Optional[str]:
    """Get the key from the list value one."""
    for key in dict_to_search:
        if list_element in dict_to_search[key]:
            return key


def find_key_from_value(
    dict_to_search: Dict[str, str], element_value: str
) -> Optional[str]:
    """Get the key from the value in a dictionary."""
    for key, value in dict_to_search.items():
        if value == element_value:
            return key


def format_title(manga_data: dict) -> str:
    """Get the MD title from the manga data."""
    attributes = manga_data.get("attributes", None)
    if attributes is None:
        return manga_data["id"]

    manga_title = attributes["title"].get("en")
    if manga_title is None:
        key = next(iter(attributes["title"]))
        manga_title = attributes["title"].get(
            attributes["originalLanguage"], attributes["title"][key]
        )
    return manga_title


def create_new_event_loop():
    """Return the event loop, create one if not there is not one running."""
    try:
        return asyncio.get_event_loop()
    except RuntimeError as e:
        if str(e).startswith("There is no current event loop in thread"):
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            return loop
        else:
            raise


def check_chapter_url_same(md_external_url: str, chapter_id: str) -> bool:
    """Check if the chapter id is present in the chapter"""
    try:
        parsed_url = urlparse(md_external_url)
        path = parsed_url.path.strip("/")
        path_segments = path.split("/")
        variable = chapter_id.strip("/")
        variable_segments = variable.split("/")
    except ValueError:
        return False

    path_match = any(segment in path_segments for segment in variable_segments)
    return path_match
