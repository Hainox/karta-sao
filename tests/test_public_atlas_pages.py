from pathlib import Path


def page(relative: str) -> str:
    return Path(relative).read_text(encoding="utf-8")


def test_yard_and_print_pages_declare_shared_atlas_shell():
    for path in ("index.html", "yards-print/index.html"):
        markup = page(path)
        assert "Городской атлас САО" in markup
        assert "brand-mark" in markup
        assert "@page{size:A3 landscape" in page("yards-print/index.html")


def test_hub_is_navigation_only_and_has_two_catalog_sections():
    markup = page("hub/index.html")
    assert "Рабочие карты" in markup
    assert "Печатные формы" in markup
    assert "../yards-print/" in markup
    assert "<iframe" not in markup
