"""End-to-end test for the chapter-card / unavailable flow.

THIS HITS THE REAL MangaDex API. It creates a real chapter under the group
you specify, then immediately edits it to clear externalUrl. Run it only
against a manga you have permission to publish to.

Usage (inside the publoader container, or anywhere config.ini lives):

    python -m scripts.test_chapter_card_e2e \\
        --manga-id <mangadex_manga_uuid> \\
        --group-id <your_group_uuid> \\
        --chapter-number 9999 \\
        --confirm

Steps:
  1. Generate the chapter-card PNG with PIL (same code path as live uploads).
  2. Log in to MangaDex (or refresh) via the singleton http_client.
  3. Delete any existing upload session.
  4. Create a new upload session for the manga.
  5. Upload the card image.
  6. Commit the chapter with externalUrl=<placeholder> + pageOrder=[card].
  7. Edit the chapter to clear externalUrl (mark unavailable).
  8. Print the chapter URL so you can eyeball it on mangadex.org.

The script does not write anything to MongoDB — it only validates that the
MangaDex side of the round-trip works the way the live workers expect.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from publoader.chapter_image import generate_chapter_card
from publoader.http import http_client
from publoader.http.properties import RequestError
from publoader.utils.config import mangadex_api_url, md_upload_api_url


def _login() -> None:
    """Force the http_client to log in / refresh the saved token."""
    http_client.login()


def _delete_existing_session() -> None:
    try:
        resp = http_client.get(f"{md_upload_api_url}", successful_codes=[404])
    except RequestError as e:
        print(f"[warn] couldn't probe existing session: {e}")
        return
    if resp.status_code == 200 and resp.data is not None:
        sid = resp.data["data"]["id"]
        print(f"[info] deleting stale upload session {sid}")
        try:
            http_client.delete(
                f"{md_upload_api_url}/{sid}", successful_codes=[404]
            )
        except RequestError as e:
            print(f"[warn] couldn't delete stale session: {e}")


def _begin_session(manga_id: str, group_id: str) -> str:
    resp = http_client.post(
        f"{md_upload_api_url}/begin",
        json={"manga": manga_id, "groups": [group_id]},
        tries=1,
    )
    if not resp.ok or resp.data is None:
        raise SystemExit(f"begin failed: {resp.status_code} {resp.data!r}")
    sid = resp.data["data"]["id"]
    print(f"[ok ] upload session: {sid}")
    return sid


def _upload_card(session_id: str, png_bytes: bytes) -> str:
    files = {"0": ("card.png", png_bytes, "image/png")}
    resp = http_client.post(f"{md_upload_api_url}/{session_id}", files=files)
    if not resp.ok or resp.data is None:
        raise SystemExit(f"image upload failed: {resp.status_code} {resp.data!r}")
    if resp.data.get("errors") or resp.data.get("result") == "error":
        raise SystemExit(f"image upload reported errors: {resp.data}")
    page_id = resp.data["data"][0]["id"]
    print(f"[ok ] uploaded card page: {page_id}")
    return page_id


def _commit_chapter(
    session_id: str,
    page_id: str,
    chapter_number: str,
    title: str,
    language: str,
    external_url: str,
) -> str:
    payload = {
        "chapterDraft": {
            "volume": None,
            "chapter": chapter_number,
            "title": title,
            "translatedLanguage": language,
            "externalUrl": external_url,
        },
        "pageOrder": [page_id],
        "termsAccepted": True,
    }
    resp = http_client.post(f"{md_upload_api_url}/{session_id}/commit", json=payload)
    if not resp.ok or resp.data is None:
        raise SystemExit(f"commit failed: {resp.status_code} {resp.data!r}")
    chap_id = resp.data["data"]["id"]
    print(f"[ok ] committed chapter: {chap_id}")
    return chap_id


def _fetch_chapter(chap_id: str) -> dict:
    resp = http_client.get(
        f"{mangadex_api_url}/chapter/{chap_id}",
        params={"includes[]": ["scanlation_group"]},
    )
    if not resp.ok or resp.data is None:
        raise SystemExit(f"fetch failed: {resp.status_code} {resp.data!r}")
    return resp.data["data"]


def _mark_unavailable(chap_id: str) -> None:
    """Mirror the workers/unavailable.py logic against the live API."""
    chap = _fetch_chapter(chap_id)
    attrs = chap["attributes"]
    payload = {
        "volume": attrs.get("volume"),
        "chapter": attrs.get("chapter"),
        "title": attrs.get("title"),
        "translatedLanguage": attrs.get("translatedLanguage"),
        "externalUrl": None,
        "version": attrs.get("version"),
        "groups": [
            rel["id"]
            for rel in chap.get("relationships", [])
            if rel.get("type") == "scanlation_group"
        ],
    }
    resp = http_client.put(f"{mangadex_api_url}/chapter/{chap_id}", json=payload)
    if not resp.ok:
        raise SystemExit(f"mark-unavailable PUT failed: {resp.status_code} {resp.data!r}")
    print(f"[ok ] cleared externalUrl on {chap_id}")

    # Re-fetch to confirm
    confirmed = _fetch_chapter(chap_id)
    final_external = confirmed["attributes"].get("externalUrl")
    final_pages = confirmed["attributes"].get("pages")
    print(
        f"[verify] externalUrl={final_external!r} pages={final_pages} "
        f"version={confirmed['attributes'].get('version')}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manga-id", required=True, help="MangaDex manga UUID")
    parser.add_argument("--group-id", required=True, help="Your scanlation group UUID")
    parser.add_argument("--chapter-number", default="0", help="Chapter number")
    parser.add_argument("--language", default="en", help="ISO language code")
    parser.add_argument(
        "--external-url",
        default="https://example.com/publoader-e2e-test",
        help="Placeholder externalUrl; will be cleared in step 7.",
    )
    parser.add_argument(
        "--manga-name",
        default="Publoader E2E Test",
        help="Manga name to print on the card",
    )
    parser.add_argument(
        "--chapter-title",
        default="Test card chapter",
        help="Chapter title to print on the card",
    )
    parser.add_argument(
        "--save-card",
        default="/tmp/publoader-e2e-card.png",
        help="Where to also drop the generated card for inspection",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Required — this hits the real API and creates a real chapter.",
    )
    args = parser.parse_args()

    if not args.confirm:
        print(
            "This will create a real chapter on MangaDex. Pass --confirm to run.",
            file=sys.stderr,
        )
        return 2

    print("[step] generating card image…")
    png = generate_chapter_card(
        manga_name=args.manga_name,
        chapter_number=args.chapter_number,
        chapter_title=args.chapter_title,
        chapter_language=args.language,
        extension_name="e2e-test",
        chapter_url=args.external_url,
    )
    Path(args.save_card).write_bytes(png)
    print(f"[ok ] card saved to {args.save_card} ({len(png)} bytes)")

    print("[step] logging in…")
    _login()

    print("[step] clearing any prior upload session…")
    _delete_existing_session()

    print("[step] beginning new upload session…")
    sid = _begin_session(args.manga_id, args.group_id)

    print("[step] uploading card…")
    page_id = _upload_card(sid, png)

    print("[step] committing chapter…")
    chap_id = _commit_chapter(
        sid,
        page_id,
        args.chapter_number,
        args.chapter_title,
        args.language,
        args.external_url,
    )
    print(f"[link] https://mangadex.org/chapter/{chap_id}")

    print("[step] marking unavailable (clearing externalUrl)…")
    _mark_unavailable(chap_id)

    print("[done] open the link above — the card should still render as the page.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
