from publoader.utils.misc import iter_aggregate_chapters


def test_dict_shape():
    payload = {
        "1": {"chapters": {"1.0": {"id": "a"}, "1.1": {"id": "b"}}},
        "2": {"chapters": {"2.0": {"id": "c"}}},
    }
    out = list(iter_aggregate_chapters(payload))
    assert [c["id"] for c in out] == ["a", "b", "c"]


def test_list_shape():
    payload = [
        {"chapters": [{"id": "a"}, {"id": "b"}]},
        {"chapters": [{"id": "c"}]},
    ]
    out = list(iter_aggregate_chapters(payload))
    assert [c["id"] for c in out] == ["a", "b", "c"]


def test_empty_input():
    assert list(iter_aggregate_chapters({})) == []
    assert list(iter_aggregate_chapters([])) == []


def test_none_returns_empty():
    assert list(iter_aggregate_chapters(None)) == []


def test_missing_chapters_key_skipped():
    payload = {"1": {"chapters": {"a": {"id": "x"}}}, "2": {}}
    out = list(iter_aggregate_chapters(payload))
    assert [c["id"] for c in out] == ["x"]


def test_garbage_volume_skipped():
    payload = {"1": "not-a-dict", "2": {"chapters": [{"id": "ok"}]}}
    out = list(iter_aggregate_chapters(payload))
    assert [c["id"] for c in out] == ["ok"]
