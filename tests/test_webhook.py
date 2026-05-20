from publoader.webhook import _parse_webhook_urls


def test_parse_empty():
    assert _parse_webhook_urls("") == []
    assert _parse_webhook_urls(None) == []


def test_parse_single():
    assert _parse_webhook_urls("https://discord.com/api/webhooks/1/abc") == [
        "https://discord.com/api/webhooks/1/abc"
    ]


def test_parse_comma_separated():
    urls = _parse_webhook_urls(
        "https://discord.com/api/webhooks/1/abc, https://discord.com/api/webhooks/2/def"
    )
    assert urls == [
        "https://discord.com/api/webhooks/1/abc",
        "https://discord.com/api/webhooks/2/def",
    ]


def test_parse_newline_separated():
    urls = _parse_webhook_urls(
        "https://discord.com/api/webhooks/1/abc\nhttps://discord.com/api/webhooks/2/def"
    )
    assert urls == [
        "https://discord.com/api/webhooks/1/abc",
        "https://discord.com/api/webhooks/2/def",
    ]


def test_parse_mixed_with_blanks():
    urls = _parse_webhook_urls(
        "a\n\n,b , \nc\n   "
    )
    assert urls == ["a", "b", "c"]
