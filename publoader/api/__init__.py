"""Stable public API for extensions.

Extensions should import only from this module. Anything else under
`publoader.*` is considered internal and may change without notice.

Versioning intent: this surface follows semver in step with the
`__api_version__` constant below. Extensions can pin a compatible range in
their `manifest.json` (`publoader_api: "^1.0.0"`).
"""
from publoader.models.dataclasses import Chapter, Manga
from publoader.state.store import (
    REMOVAL_MODE_DELETE,
    REMOVAL_MODE_UNAVAILABLE,
)
from publoader.utils.logs import setup_extension_logs
from publoader.utils.misc import create_new_event_loop, find_key_from_list_value
from publoader.utils.utils import (
    chapter_number_regex,
    open_manga_id_map,
    open_title_regex,
)
from publoader.webhook import PubloaderWebhook

__api_version__ = "1.0.0"

# Extension contract:
#   Set `Extension.chapter_removal_mode = REMOVAL_MODE_DELETE` (or
#   REMOVAL_MODE_UNAVAILABLE) to force a removal behaviour regardless of
#   the global setting controlled via the bot. Leaving it unset (or None)
#   defers to the global.

__all__ = [
    "Chapter",
    "Manga",
    "PubloaderWebhook",
    "REMOVAL_MODE_DELETE",
    "REMOVAL_MODE_UNAVAILABLE",
    "chapter_number_regex",
    "create_new_event_loop",
    "find_key_from_list_value",
    "open_manga_id_map",
    "open_title_regex",
    "setup_extension_logs",
    "__api_version__",
]
