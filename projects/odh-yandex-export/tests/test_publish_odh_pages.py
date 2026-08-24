import json

import pytest

from scripts.publish_odh_pages import build_publish_bundle


def test_build_publish_bundle_writes_shell_manifest_and_layers(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    for name in ("sao_boundary_wgs84.geojson", "sao_wave1_complete_wgs84.geojson"):
        (source / name).write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")

    created = build_publish_bundle(source, tmp_path / "site")

    manifest = json.loads((tmp_path / "site" / "layers.json").read_text(encoding="utf-8"))
    assert (tmp_path / "site" / "index.html") in created
    assert (tmp_path / "site" / "print-a3.html") in created
    assert [layer["key"] for layer in manifest["layers"]] == ["boundary", "wave1"]
    assert manifest["layers"][0]["url"].startswith("layers/")
    assert "FeatureCollection" in (tmp_path / "site" / manifest["layers"][0]["url"]).read_text(encoding="utf-8")


def test_build_publish_bundle_names_a_missing_required_boundary_layer(tmp_path):
    source = tmp_path / "source"
    source.mkdir()

    with pytest.raises(FileNotFoundError, match="sao_boundary_wgs84\\.geojson"):
        build_publish_bundle(source, tmp_path / "site")


def test_release_bundle_validation_requires_every_expected_layer(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "sao_boundary_wgs84.geojson").write_text(
        '{"type":"FeatureCollection","features":[]}', encoding="utf-8"
    )

    with pytest.raises(FileNotFoundError, match="sao_wave1_complete_wgs84\\.geojson"):
        build_publish_bundle(source, tmp_path / "site", validate_all_layers=True)
