"""Shared MSK-77 (PMSK Moscow) <-> WGS-84 coordinate conversion.

Extracted from odh_yandex_export.py so every script that talks to
reestr-ogh.mos.ru converts coordinates the same, audited way, instead of
each script re-implementing (and potentially re-breaking) the geodesy.

See odh_yandex_export.py for the full citation / audit notes on where these
parameters come from. Short version: Moscow's own local system (МСК-77 /
МГГТ / ПМСК Moscow) sits on the Bessel 1841 ellipsoid (confirmed unusual
special case, not a typo), origin 55°40'N/37°30'E, zero false easting/
northing. Source: https://gis-lab.info/qa/msk-wkt2.html, citing the official
"Положение о ПМСК Москвы" (http://sngo.mggt.ru/documents/sngo/PMSK_Moscow.pdf).

Requires: pyproj (python -m pip install pyproj)
"""
from __future__ import annotations

from typing import Any

MSK77_WKT2 = """
BOUNDCRS[
    SOURCECRS[
        PROJCRS["PMSK Moscow",
            BASEGEOGCRS["Unknown datum based upon the Bessel 1841 ellipsoid",
                DATUM["Not specified (based on Bessel 1841 ellipsoid)",
                    ELLIPSOID["Bessel 1841",6377397.155,299.1528128,
                        LENGTHUNIT["metre",1,
                            ID["EPSG",9001]]]],
                PRIMEM["Greenwich",0,
                    ANGLEUNIT["degree",0.0174532925199433],
                    ID["EPSG",8901]]],
            CONVERSION["Moscow",
                METHOD["Transverse Mercator",
                    ID["EPSG",9807]],
                PARAMETER["Latitude of natural origin",55.6666666666667,
                    ANGLEUNIT["degree",0.0174532925199433],
                    ID["EPSG",8801]],
                PARAMETER["Longitude of natural origin",37.5,
                    ANGLEUNIT["degree",0.0174532925199433],
                    ID["EPSG",8802]],
                PARAMETER["Scale factor at natural origin",1,
                    SCALEUNIT["unity",1],
                    ID["EPSG",8805]],
                PARAMETER["False easting",0,
                    LENGTHUNIT["metre",1],
                    ID["EPSG",8806]],
                PARAMETER["False northing",0,
                    LENGTHUNIT["metre",1],
                    ID["EPSG",8807]]],
            CS[Cartesian,2],
                AXIS["(E)",east,
                    ORDER[1],
                    LENGTHUNIT["metre",1,
                        ID["EPSG",9001]]],
                AXIS["(N)",north,
                    ORDER[2],
                    LENGTHUNIT["metre",1,
                        ID["EPSG",9001]]],
            USAGE[
                SCOPE["Engineering surveying and land cadastre."],
                AREA["Moscow and adjacent districts of the Moscow Region."],
                BBOX[55.13,36.78,56.23,38.49]]]],
    TARGETCRS[
        GEOGCRS["WGS 84",
            DATUM["World Geodetic System 1984",
                ELLIPSOID["WGS 84",6378137,298.257223563,
                    LENGTHUNIT["metre",1]]],
            PRIMEM["Greenwich",0,
                ANGLEUNIT["degree",0.0174532925199433]],
            CS[ellipsoidal,2],
                AXIS["geodetic latitude (Lat)",north,
                    ORDER[1],
                    ANGLEUNIT["degree",0.0174532925199433]],
                AXIS["geodetic longitude (Lon)",east,
                    ORDER[2],
                    ANGLEUNIT["degree",0.0174532925199433]],
            ID["EPSG",4326]]],
    ABRIDGEDTRANSFORMATION["Transformation from Moscow to WGS84",
        METHOD["Coordinate Frame rotation (geog2D domain)",
            ID["EPSG",9607]],
        PARAMETER["X-axis translation",316.151,
            ID["EPSG",8605]],
        PARAMETER["Y-axis translation",78.924,
            ID["EPSG",8606]],
        PARAMETER["Z-axis translation",589.650,
            ID["EPSG",8607]],
        PARAMETER["X-axis rotation",1.57273,
            ID["EPSG",8608]],
        PARAMETER["Y-axis rotation",-2.69209,
            ID["EPSG",8609]],
        PARAMETER["Z-axis rotation",-2.34693,
            ID["EPSG",8610]],
        PARAMETER["Scale difference",1.0000084507,
            ID["EPSG",8611]]]]
"""

_WGS84_TRANSFORMER = None


def get_transformer():
    global _WGS84_TRANSFORMER
    if _WGS84_TRANSFORMER is None:
        try:
            from pyproj import Transformer
        except ImportError as exc:
            raise RuntimeError(
                "Для пересчёта координат МСК-77 → WGS84 установите пакет pyproj: "
                "python -m pip install pyproj"
            ) from exc
        _WGS84_TRANSFORMER = Transformer.from_crs(MSK77_WKT2, "EPSG:4326", always_xy=True)
    return _WGS84_TRANSFORMER


def self_check_transformer() -> None:
    """The projection's own origin (0, 0) must map back to its defining
    point (55°40'N, 37°30'E). Catches a broken/too-old PROJ install early,
    instead of silently exporting wrong coordinates."""
    lon, lat = get_transformer().transform(0.0, 0.0)
    if abs(lon - 37.5) > 0.01 or abs(lat - 55.66666666667) > 0.01:
        raise RuntimeError(
            "Проверка пересчёта МСК-77 → WGS84 не пройдена: точка (0, 0) должна "
            f"давать примерно (37.5, 55.6667), а получено ({lon:.6f}, {lat:.6f}). "
            "Проверьте версию pyproj/PROJ (нужна поддержка WKT2/BOUNDCRS, PROJ >= 6): "
            "python -m pip install -U pyproj"
        )


def msk77_to_wgs84_point(coord: list[float]) -> list[float]:
    lon, lat = get_transformer().transform(float(coord[0]), float(coord[1]))
    return [lon, lat]


def transform_coords(value: Any, point_transform=msk77_to_wgs84_point) -> Any:
    """Recursively convert a GeoJSON-style coordinates structure (a nested
    list ending in [x, y] pairs) from MSK-77 metres to WGS-84 degrees."""
    if value is None:
        return None
    if isinstance(value, list) and len(value) == 2 and all(isinstance(v, (int, float)) for v in value):
        return point_transform(value)
    return [transform_coords(item, point_transform) for item in value]
