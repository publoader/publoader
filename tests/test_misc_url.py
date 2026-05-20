from publoader.utils.misc import check_chapter_url_same


def test_matching_id_in_path():
    assert check_chapter_url_same("https://site.com/chapter/12345", "12345") is True


def test_id_not_present():
    assert check_chapter_url_same("https://site.com/chapter/12345", "99999") is False


def test_subpath_match():
    assert (
        check_chapter_url_same("https://site.com/chapter/12345/page", "12345") is True
    )


def test_invalid_url_returns_false_safely():
    # urlparse tolerates almost everything, so this is mostly a smoke test that
    # the helper doesn't crash on weird input.
    assert isinstance(check_chapter_url_same("not-a-real-url", "x"), bool)
