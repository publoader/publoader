import logging
import threading
import time
from json import JSONDecodeError
from typing import Dict, List, Optional, Union

from discord_webhook import DiscordEmbed, DiscordWebhook

from publoader.models.dataclasses import Chapter
from publoader.utils.config import config
from publoader.utils.utils import EXPIRE_TIME, get_current_datetime

logger = logging.getLogger("webhook")


def _parse_webhook_urls(raw: Optional[str]) -> List[str]:
    """Accept a single URL, or comma/newline-separated list."""
    if not raw:
        return []
    parts = [chunk.strip() for chunk in raw.replace(",", "\n").splitlines()]
    return [p for p in parts if p]


webhook_urls: List[str] = _parse_webhook_urls(config["Paths"].get("webhook_url"))
# Back-compat alias — some external code may read this.
webhook_url = webhook_urls[0] if webhook_urls else None


def make_webhook():
    # discord_webhook supports url=list[str], posting to every URL on .execute().
    if not webhook_urls:
        return DiscordWebhook(url="", rate_limit_retry=True)
    return DiscordWebhook(
        url=webhook_urls if len(webhook_urls) > 1 else webhook_urls[0],
        rate_limit_retry=True,
    )


webhook = make_webhook()
COLOUR = "B86F8C"

# Thread-local guard so the error log handler can't recurse into itself when
# the webhook send path itself logs at ERROR.
_emit_guard = threading.local()


class WebhookHelper:
    def __init__(self, **kwargs) -> None:
        self.extension_name = kwargs.get("extension_name")
        self.colour = kwargs.get("colour") or COLOUR
        self.mangadex_chapter_url = "https://mangadex.org/chapter/{}"
        self.mangadex_manga_url = "https://mangadex.org/manga/{}"
        self.footer = (
            {
                "text": f"{'' if self.extension_name.startswith('extensions.') else 'extensions.'}{self.extension_name}"
            }
            if self.extension_name is not None
            else None
        )

    def _format_link(
        self,
        name: Optional[str] = None,
        url: Optional[str] = None,
        type: Optional[str] = None,
        skip_chapter_id: bool = False,
    ):
        if name is not None:
            name = name.title()

        if type is not None:
            type = type.lower()

        if skip_chapter_id or url is None:
            return ""

        return f"{name} {type} link: [here]({url})\n"

    def normalise_chapter(
        self,
        chapter: Union[Chapter, dict],
        failed_upload: bool = False,
        inline: bool = True,
        success: bool = False,
    ) -> Dict[str, str]:
        if isinstance(chapter, Chapter):
            chapter = vars(chapter)

        name = f"Success: {success}\nManga: {chapter.get('manga_name')}\nChapter: {chapter.get('chapter_number')}\nExtension: {chapter.get('extension_name')}"
        value = (
            f"Language: `{chapter.get('chapter_language')}`\n"
            f"Chapter title: `{chapter.get('chapter_title')}`\n"
            f"Chapter expiry: `{(chapter.get('chapter_expire') or EXPIRE_TIME).isoformat()}`\n"
            "\n"
            f"{self._format_link(name='MangaDex', type='chapter', url=self.mangadex_chapter_url.format(chapter.get('md_chapter_id')), skip_chapter_id=failed_upload)}"
            f"{self._format_link(name='MangaDex', type='manga', url=self.mangadex_manga_url.format(chapter.get('md_manga_id')), skip_chapter_id=failed_upload)}"
            "\n"
            f"{self._format_link(name=chapter.get('extension_name'), type='chapter', url=chapter.get('chapter_url'))}"
            f"{self._format_link(name=chapter.get('extension_name'), type='manga', url=chapter.get('manga_url'))}"
        )

        return {"name": name, "value": value, "inline": inline}

    def normalise_chapters(self, chapters, failed_upload: bool = False):
        normalised_chapters = [
            self.normalise_chapter(chapter, failed_upload) for chapter in chapters
        ]
        return [
            normalised_chapters[elem : elem + 25]
            for elem in range(0, len(normalised_chapters), 25)
        ]

    def make_embed(self, embed_data: Optional[dict] = None) -> DiscordEmbed:
        embed = DiscordEmbed(**embed_data, footer=self.footer)
        embed.set_title(embed_data.get("title", None))
        embed.set_description(embed_data.get("description", None))
        logger.debug(f"Made embed: {embed.title}, {embed.description}")
        return embed

    def add_fields_to_embed(
        self, embed: "DiscordEmbed", normalised_chapters: List[dict]
    ):
        logger.debug(f"Adding chapters to embed {embed.title}: {normalised_chapters}")
        for c in normalised_chapters:
            embed.add_embed_field(**c)

    @staticmethod
    def _embed_as_dict(embed: Union["DiscordEmbed", dict]) -> dict:
        if isinstance(embed, dict):
            return embed
        return dict(embed.__dict__)

    def _calculate_embed_size(self, embed: Union[DiscordEmbed, dict]) -> int:
        embed_dict = self._embed_as_dict(embed)
        embed_len = len(embed_dict.get("title") or "")
        embed_len += len(embed_dict.get("description") or "")
        footer = embed_dict.get("footer") or {}
        embed_len += len(footer.get("text") or "") if isinstance(footer, dict) else 0

        for field in embed_dict.get("fields") or []:
            embed_len += len(field.get("name") or "") + len(field.get("value") or "")
        return embed_len

    def _make_multiple_embeds(self, embed: Union["DiscordEmbed", dict], list_fields: List[List[dict]]):
        embed_dict = self._embed_as_dict(embed)
        new_embeds = []
        for fields in list_fields:
            new_embed = DiscordEmbed(footer=self.footer)
            new_embed.__dict__.update(embed_dict)
            new_embed.fields = fields

            embed_len = self._calculate_embed_size(new_embed)
            new_embed_split = self._check_embed_length(new_embed, embed_len)
            if new_embed_split is None:
                new_embeds.append(new_embed)
            else:
                new_embeds.extend(new_embed_split)
        return new_embeds

    def _check_embed_length(self, embed: Union["DiscordEmbed", dict], embed_len: int):
        if embed_len < 6000:
            return None

        embed_dict = self._embed_as_dict(embed)
        num_fields = embed_dict.get("fields") or []
        splitter = 6

        fields_split = [
            num_fields[elem : elem + splitter]
            for elem in range(0, len(num_fields), splitter)
        ]

        return self._make_multiple_embeds(embed_dict, fields_split)

    def check_embeds_size(self, local_webhook: DiscordWebhook):
        embeds = local_webhook.get_embeds()
        for index, embed in enumerate(embeds):
            embed_len = self._calculate_embed_size(embed)
            split_embeds = self._check_embed_length(embed, embed_len)

            if split_embeds is not None:
                local_webhook.embeds.pop(index)
                local_webhook.embeds[index:index] = split_embeds

    def send_webhook(self, local_webhook: DiscordWebhook = webhook):
        if not webhook_urls:
            return

        if not local_webhook.embeds:
            return

        self.check_embeds_size(local_webhook)

        embeds_split = [
            local_webhook.embeds[elem : elem + 10]
            for elem in range(0, len(local_webhook.embeds), 10)
        ]
        local_webhook.embeds.clear()

        for count, embed in enumerate(embeds_split, start=1):
            local_webhook.embeds = embed
            response = local_webhook.execute(remove_embeds=True)
            try:
                if isinstance(response, list):
                    status_codes = [r.status_code for r in response]
                    messages = [r.json() for r in response]
                    logger.info(f"Discord API returned: {status_codes}, {messages}")
                else:
                    logger.info(
                        f"Discord API returned: {response.status_code}, {response.json()}"
                    )
            except (JSONDecodeError, AttributeError, KeyError) as e:
                logger.error(e)

            if count < len(embeds_split):
                time.sleep(1)


class WebhookBase(WebhookHelper):
    def __init__(
        self,
        extension_name: str,
        manga: dict,
    ) -> None:
        super().__init__(extension_name=extension_name)
        self.manga = manga
        logger.debug(f"Making embed for manga {self.manga}")
        self.manga_id = manga.get("id", "Manga id not found")
        self.manga_title = manga.get("title", "Manga title not found")
        self.mangadex_manga_url = self.mangadex_manga_url.format(self.manga_id)


class PubloaderUpdatesWebhook(WebhookBase):
    def __init__(
        self,
        extension_name: str,
        manga: dict,
        chapters: List["Chapter"],
        failed_chapters: List["Chapter"],
        skipped: int,
        edited: int,
        clean_db: bool,
    ) -> None:
        super().__init__(extension_name, manga)

        self.chapters: List["Chapter"] = chapters
        self.failed_chapters = failed_chapters

        self.uploaded = len(chapters)
        self.failed = len(self.failed_chapters)
        self.skipped = skipped
        self.edited = edited
        self.clean_db = clean_db

        self.normalised_manga = self.normalise_manga(
            self.uploaded, self.failed, self.skipped, self.edited
        )
        self.normalised_chapters = self.normalise_chapters(self.chapters)
        self.normalised_failed_chapters = self.normalise_chapters(
            self.failed_chapters, failed_upload=True
        )

    def normalise_manga(
        self, chapter_count: int, failed: int, skipped: int, edited: int
    ) -> Dict[str, str]:
        return {
            "title": f"{self.manga_title}",
            "description": f"MangaDex manga link: [here]({self.mangadex_manga_url})\n"
            f"To Upload: {chapter_count}\n"
            f"Skipped: {skipped}\n"
            f"To Edit: {edited}",
            "timestamp": get_current_datetime().isoformat(),
            "color": self.colour,
        }

    def format_embed(self, chapters_to_use: List[List[dict]]):
        for chapter_list in chapters_to_use:
            embed = self.make_embed(self.normalised_manga)
            if self.extension_name:
                embed.footer = {"text": f"extensions.{self.extension_name}"}
            self.add_fields_to_embed(embed, chapter_list)

            if chapter_list:
                webhook.add_embed(embed)

            if len(webhook.embeds) >= 10 or len(embed.fields) >= 5:
                self.send_webhook()

    def main(self, last_manga: bool = True):
        if self.uploaded > 0 or self.failed > 0:
            self.send_webhook()

        if self.chapters:
            self.format_embed(self.normalised_chapters)
        if self.failed_chapters:
            self.format_embed(self.normalised_failed_chapters)
        if self.edited > 0:
            embed = self.make_embed(self.normalised_manga)
            webhook.add_embed(embed)
        if self.skipped > 0 and not self.clean_db:
            embed = self.make_embed(self.normalised_manga)
            webhook.add_embed(embed)

        if last_manga:
            embed = self.make_embed(
                {"title": "Finished Getting all chapter updates.", "color": self.colour}
            )
            webhook.add_embed(embed)

        if self.uploaded > 0 or self.failed > 0:
            self.send_webhook()
        else:
            if len(webhook.embeds) >= 10:
                webhook_embeds = [
                    webhook.embeds[elem : elem + 10]
                    for elem in range(0, len(webhook.embeds), 10)
                ]
                for embed_list in webhook_embeds:
                    webhook.embeds = embed_list
                    if len(webhook.embeds) >= 10:
                        self.send_webhook()

            if last_manga:
                self.send_webhook()


class PubloaderQueueWebhook(WebhookHelper):
    def __init__(self, worker_type: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self.webhook = make_webhook()
        self.worker_type = worker_type.capitalize()
        self.fields = []

    def normalise_embed(self) -> Dict[str, str]:
        return {
            "title": self.worker_type,
            "timestamp": get_current_datetime().isoformat(),
            "color": self.colour,
        }

    def add_chapter(self, chapter: dict, processed: bool = True):
        if self.worker_type.lower() in ["uploader", "deleter"]:
            if self.worker_type.lower() == "uploader" and not processed:
                pass
            else:
                return

        self.fields.append(self.normalise_chapter(chapter, success=processed))

        if len(self.fields) >= 6:
            embed = self.make_embed(self.normalise_embed())
            self.add_fields_to_embed(embed, self.fields)

            self.webhook.add_embed(embed)
            self.send_webhook(self.webhook)

            self.fields[:] = []

    def send_queue_finished(self):
        # embed = self.make_embed(self.normalise_embed())
        embed_last = self.make_embed(
            {
                "title": f"{self.worker_type}: Finished all items in queue",
                "color": self.colour,
            }
        )
        # self.add_fields_to_embed(embed, self.fields)
        self.fields[:] = []

        # self.webhook.add_embed(embed)
        self.webhook.add_embed(embed_last)
        self.send_webhook(self.webhook)


class PubloaderDupesWebhook(WebhookBase):
    def __init__(self, extension_name: str, manga: Optional[dict] = None) -> None:
        self.extension_name = extension_name
        self.normalised_manga = None
        self.manga = manga
        if manga is not None:
            self.init_manga(manga)

        self.chapters = []

    def init_manga(self, manga: Optional[dict]):
        if manga is not None:
            super().__init__(self.extension_name, manga)
            self.colour = "C8AA69"
            self.normalised_manga = self.normalise_manga()

    def normalise_manga(self) -> Dict[str, str]:
        return {
            "title": f"Dupes in: {self.manga_title}",
            "description": f"""MangaDex manga link: [here]({self.mangadex_manga_url})""",
            "timestamp": get_current_datetime().isoformat(),
            "color": self.colour,
        }

    def add_chapters(self, main_chapter: dict, chapters: List[dict]):
        self.chapters.append(
            {
                "name": f"Dupes of chapter: {main_chapter['id']}\n"
                f"Chapter Number: {main_chapter['attributes']['chapter']}\n"
                f"Chapter Language: {main_chapter['attributes']['translatedLanguage']}",
                "value": self.normalise_chapters(chapters),
            }
        )

    def add_chapter(self, chapters: List[dict]):
        self.chapters.append(
            {
                "name": f"Dupes",
                "value": self.normalise_chapters(chapters),
            }
        )

    def normalise_chapters(self, chapters: List[dict]) -> str:
        return "\n".join([f'`{chapter["id"]}`' for chapter in chapters])

    def main(self):
        if self.normalised_manga is not None:
            logger.info(self.normalised_manga)
            embed = self.make_embed(self.normalised_manga)
            self.add_fields_to_embed(embed, self.chapters)
            logger.info(self.chapters)

            if self.chapters:
                webhook.add_embed(embed)
                self.send_webhook()


class PubloaderNotIndexedWebhook(WebhookHelper):
    def __init__(
        self,
        extension_name: str,
        chapters_not_indexed: List[str],
        chapters_indexed: int,
    ) -> None:
        super().__init__(extension_name=extension_name)
        self.chapters_not_indexed = chapters_not_indexed
        self.chapters_indexed = chapters_indexed
        self.colour = "45539B"

    def make_embed(self, **embed_data):
        embed = DiscordEmbed(
            title=embed_data["title"],
            description=embed_data["description"],
            **{
                "color": self.colour,
                "timestamp": get_current_datetime().isoformat(),
            },
            footer=self.footer,
        )

        logger.debug(f"Made embed: {embed.title}, {embed.description}")
        return embed

    def main(self):
        title = (
            f"{len(self.chapters_not_indexed)} chapters not indexed:"
            if self.chapters_not_indexed
            else f"{self.chapters_indexed} chapters indexed"
        )
        description = (
            "```" + "\n".join(self.chapters_not_indexed) + "```"
            if self.chapters_not_indexed
            else None
        )

        description = ("\n" + description) if description else None

        embed = self.make_embed(title=title, description=description)
        webhook.add_embed(embed)
        self.send_webhook()


class PubloaderWebhook(WebhookHelper):
    def __init__(self, extension_name: str, **kwargs) -> None:
        super().__init__(extension_name=extension_name)
        self.embed = None
        self.embed_title = kwargs.get("title")
        self.embed_description = kwargs.get("description")
        self.embed_colour = kwargs.get("colour")
        self.footer = kwargs.get("footer", self.footer)
        self.timestamp = kwargs.get("timestamp", get_current_datetime().isoformat())
        self.add_timestamp = kwargs.get("add_timestamp", True)

    def main(self, **kwargs):
        self.embed = DiscordEmbed(
            title=self.embed_title,
            description=self.embed_description,
            color=self.embed_colour or self.colour,
            footer=self.footer,
        )

        if self.add_timestamp:
            self.embed.timestamp = self.timestamp
        webhook.add_embed(self.embed)

        if len(webhook.embeds) >= 5:
            self.send_webhook()

    def send(self, **kwargs):
        self.main()
        self.send_webhook()


class WebhookLogHandler(logging.Handler):
    """Logging handler that fires a webhook (or bot notification) on every
    ERROR-level (or higher) log record. Re-entrancy is guarded so that a
    failure inside the webhook send path doesn't loop back into itself."""

    def __init__(self, level: int = logging.ERROR):
        super().__init__(level=level)
        # Quieter formatter — record content goes inside a code block on Discord.
        self.setFormatter(
            logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s")
        )

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(_emit_guard, "active", False):
            return
        if record.name in ("webhook", "discord_webhook"):
            return
        if not webhook_urls:
            return
        _emit_guard.active = True
        try:
            msg = self.format(record)
            title = f"{record.levelname}: {record.name}"
            description = f"```\n{msg[:1800]}\n```"
            PubloaderWebhook(
                extension_name=None,
                title=title,
                description=description,
                colour="FF0000",
            ).send()
        except Exception:
            self.handleError(record)
        finally:
            _emit_guard.active = False


def attach_error_webhook_handler(logger_name: str = "publoader") -> None:
    """Attach the error-firing handler to a logger. Idempotent."""
    target = logging.getLogger(logger_name)
    if any(isinstance(h, WebhookLogHandler) for h in target.handlers):
        return
    target.addHandler(WebhookLogHandler())


if __name__ == "__main__":
    print("Please run this file through the bot.")
