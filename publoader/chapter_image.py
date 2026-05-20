"""Render a per-chapter info card image used as the visible page on
MangaDex when the publisher takes the chapter down. Generated once at
upload time and persisted to GridFS alongside any extension-provided pages.
"""
from __future__ import annotations

from io import BytesIO
from typing import Optional

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:  # pragma: no cover - dependency guard
    Image = None  # type: ignore[assignment]
    ImageDraw = None  # type: ignore[assignment]
    ImageFont = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


# 5:7 portrait — matches a typical manga page ratio so the card doesn't look
# stretched when sandwiched between real pages.
_CARD_WIDTH = 1200
_CARD_HEIGHT = 1680

_BG_COLOUR = (255, 255, 255)
_TEXT = (0, 0, 0)
_TEXT_FOOTER = (130, 130, 130)

_FONT_PATHS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:\\Windows\\Fonts\\arialbd.ttf",
)


def _load_font(size: int):
    if ImageFont is None:
        return None
    for p in _FONT_PATHS:
        try:
            return ImageFont.truetype(p, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def _wrap(text: str, max_chars: int) -> list:
    """Cheap word-wrap. Not a glyph-aware wrapper but good enough for ASCII +
    typical titles."""
    if not text:
        return []
    out: list = []
    line: list = []
    line_len = 0
    for word in text.split():
        wlen = len(word)
        if line_len + wlen + (1 if line else 0) > max_chars and line:
            out.append(" ".join(line))
            line = [word]
            line_len = wlen
        else:
            line.append(word)
            line_len += wlen + (1 if line_len else 0)
    if line:
        out.append(" ".join(line))
    return out


def generate_chapter_card(
    *,
    manga_name: Optional[str] = None,
    chapter_number: Optional[str] = None,
    chapter_title: Optional[str] = None,
    chapter_language: Optional[str] = None,
    extension_name: Optional[str] = None,
    chapter_url: Optional[str] = None,
    width: int = _CARD_WIDTH,
    height: int = _CARD_HEIGHT,
) -> bytes:
    """Return PNG bytes for an info card describing this chapter."""
    if Image is None:
        raise RuntimeError(
            f"Pillow is not installed; cannot generate chapter cards: {_IMPORT_ERROR}"
        )

    img = Image.new("RGB", (width, height), color=_BG_COLOUR)
    draw = ImageDraw.Draw(img)

    cx = width // 2
    margin = 80

    # ---- manga name (wrapped) ----
    title_font = _load_font(76)
    name_lines = _wrap(manga_name or "Untitled", max_chars=24)[:3] or ["Untitled"]
    y = margin + 120
    for line in name_lines:
        draw.text((cx, y), line, fill=_TEXT, font=title_font, anchor="mm")
        y += 96

    # ---- big chapter heading ----
    chap_font = _load_font(150)
    chap_text = f"Chapter {chapter_number}" if chapter_number else "Chapter"
    draw.text((cx, height // 2 - 80), chap_text,
              fill=_TEXT, font=chap_font, anchor="mm")

    # ---- chapter title (wrapped) ----
    if chapter_title:
        body_font = _load_font(48)
        for i, line in enumerate(_wrap(chapter_title, max_chars=36)[:3]):
            draw.text(
                (cx, height // 2 + 80 + i * 64),
                line,
                fill=_TEXT,
                font=body_font,
                anchor="mm",
            )

    # ---- bottom metadata block ----
    meta_font = _load_font(40)
    meta_y = height - margin - 320
    if chapter_language:
        draw.text(
            (cx, meta_y),
            f"Language  ·  {chapter_language}",
            fill=_TEXT,
            font=meta_font,
            anchor="mm",
        )
        meta_y += 60
    if extension_name:
        draw.text(
            (cx, meta_y),
            f"Source  ·  {extension_name}",
            fill=_TEXT,
            font=meta_font,
            anchor="mm",
        )
        meta_y += 60

    # URL footer (truncated to ~80 chars so we don't overflow the card).
    if chapter_url:
        url_font = _load_font(32)
        text = chapter_url if len(chapter_url) <= 80 else chapter_url[:77] + "..."
        draw.text(
            (cx, height - margin - 110),
            text,
            fill=_TEXT_FOOTER,
            font=url_font,
            anchor="mm",
        )

    note_font = _load_font(32)
    draw.text(
        (cx, height - margin - 50),
        "Original chapter on publisher's site",
        fill=_TEXT_FOOTER,
        font=note_font,
        anchor="mm",
    )

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
