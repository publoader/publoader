from datetime import datetime
from typing import List, Optional

from pydantic import field_validator
from pydantic.dataclasses import dataclass


@dataclass()
class Manga:
    manga_id: str
    manga_name: str
    manga_language: str
    manga_url: str


@dataclass()
class Chapter:
    chapter_lookup: Optional[datetime] = None
    chapter_timestamp: Optional[datetime] = None
    chapter_language: Optional[str] = None

    chapter_expire: Optional[datetime] = None
    chapter_number: Optional[str] = None
    chapter_title: Optional[str] = None
    chapter_volume: Optional[str] = None
    chapter_id: Optional[str] = None
    chapter_url: Optional[str] = None
    md_chapter_id: Optional[str] = None

    manga_id: Optional[str] = None
    md_manga_id: Optional[str] = None

    manga_name: Optional[str] = None
    manga_url: Optional[str] = None

    extension_name: Optional[str] = None

    images: Optional[List[bytes]] = None

    @field_validator(
        "chapter_language",
        "chapter_number",
        "chapter_title",
        "chapter_id",
        "chapter_url",
        "md_chapter_id",
        "manga_id",
        "manga_name",
        "manga_url",
        "extension_name",
        mode="before",
    )
    def transform_id_to_str(cls, value) -> Optional[str]:
        if value is None:
            return None
        return str(value)

    def _identity(self):
        return (
            self.chapter_id,
            self.chapter_number,
            self.chapter_language,
            self.manga_id,
            self.manga_name,
        )

    def __hash__(self):
        return hash(self._identity())

    def __eq__(self, other):
        if not isinstance(other, Chapter):
            return NotImplemented
        return self._identity() == other._identity()
