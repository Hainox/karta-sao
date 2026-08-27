import importlib
import pytest

@pytest.mark.parametrize("package", ["requests", "openpyxl", "pyproj", "pypdf"])
def test_required_package_is_importable(package):
    assert importlib.import_module(package)
