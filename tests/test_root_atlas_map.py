import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def test_choosing_a_district_or_section_moves_the_map_to_it():
    markup = (REPO / "index.html").read_text(encoding="utf-8")
    district_handler = re.search(r"\$\('districtSelect'\)\.addEventListener\('change'.*?\}\);", markup, re.S).group(0)
    section_handler = re.search(r"\$\('sectionSelect'\)\.addEventListener\('change'.*?\}\);", markup, re.S).group(0)

    assert "fitToSelection()" in district_handler
    assert "fitToSelection()" in section_handler


def test_lazy_layers_show_their_published_count_before_loading():
    """До включения слоя счётчик показывает число объектов в опубликованном файле, а не 0."""
    markup = (REPO / "index.html").read_text(encoding="utf-8")
    for key in ("smm_storage", "urns"):
        config = re.search(rf"\b{key}: \{{[^}}]*\}}", markup).group(0)
        file = re.search(r"file: '([^']+)'", config).group(1)
        expected = int(re.search(r"expected: (\d+)", config).group(1))
        features = json.loads((REPO / file).read_text(encoding="utf-8"))["features"]
        assert expected == len(features), key
