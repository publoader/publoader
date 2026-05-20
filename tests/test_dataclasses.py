"""Cover the corrected Chapter.__eq__ / __hash__ contract."""
from publoader.models.dataclasses import Chapter


def test_equal_when_identity_tuple_matches():
    a = Chapter(chapter_id="1", chapter_number="1", chapter_language="en",
                manga_id="m", manga_name="title")
    b = Chapter(chapter_id="1", chapter_number="1", chapter_language="en",
                manga_id="m", manga_name="title")
    assert a == b


def test_not_equal_when_field_differs():
    a = Chapter(chapter_id="1", chapter_number="1", chapter_language="en",
                manga_id="m", manga_name="title")
    b = Chapter(chapter_id="2", chapter_number="1", chapter_language="en",
                manga_id="m", manga_name="title")
    assert a != b


def test_not_equal_to_unrelated_object():
    a = Chapter(chapter_id="1")
    assert (a == "unrelated") is False
    assert (a == 12345) is False


def test_hashable():
    a = Chapter(chapter_id="1", chapter_number="1", chapter_language="en")
    s = {a}
    s.add(Chapter(chapter_id="1", chapter_number="1", chapter_language="en"))
    assert len(s) == 1
