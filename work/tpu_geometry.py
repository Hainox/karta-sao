"""Reproject inherited TPU contours using the atlas SMM conversion.

Recover MSK-77 coordinates from the inherited atlas conversion before applying
the SMM datum parameters. Keep source layers and every polygon vertex intact.
This is a visual alignment correction, not a cadastral survey certification.
"""
from copy import deepcopy

from pyproj import CRS, Geod, Transformer
from shapely.geometry import shape


_PROJECTION = (
    '+proj=tmerc +lat_0=55.66666666667 +lon_0=37.5 +k=1 '
    '+x_0={easting} +y_0={northing} +ellps=bessel '
    '+towgs84=316.151,78.924,589.65,-1.57273,2.69209,2.34693,8.4507 '
    '+units=m +no_defs'
)
OLD_CRS_WKT = CRS.from_proj4(
    _PROJECTION.format(easting=0, northing=0)
).to_wkt(version='WKT2_2019')
_INVERSE = Transformer.from_crs('EPSG:4326', OLD_CRS_WKT, always_xy=True)
ALIGNED_CRS_WKT = CRS.from_proj4(
    '+proj=tmerc +lat_0=55.66666666667 +lon_0=37.5 +k=1 '
    '+x_0=0 +y_0=0 +ellps=bessel '
    '+towgs84=367.93,88.45,553.73,-0.8777,1.3231,2.6248,8.96 '
    '+units=m +no_defs'
).to_wkt(version='WKT2_2019')
_FORWARD = Transformer.from_crs(ALIGNED_CRS_WKT, 'EPSG:4326', always_xy=True)
_GEOD = Geod(ellps='WGS84')

CORRECTION_METADATA = {
    'method': 'Inverse inherited MSK-77 conversion, then atlas SMM datum conversion',
    'old_false_easting_m': 0,
    'old_false_northing_m': 0,
    'corrected_false_easting_m': 0,
    'corrected_false_northing_m': 0,
    'datum_parameters': '367.93,88.45,553.73,-0.8777,1.3231,2.6248,8.96',
    'parameter_source': 'Atlas SMM coordinate conversion',
    'coordinate_order': 'longitude, latitude',
    'validation': 'Visual alignment checked on Baltiyskaya and Dynamo; source boundaries may differ from basemap detail',
}


def _coordinates(value):
    if not value:
        return []
    if isinstance(value[0], (int, float)):
        x, y = _INVERSE.transform(value[0], value[1])
        lon, lat = _FORWARD.transform(x, y)
        return [lon, lat, *value[2:]]
    return [_coordinates(part) for part in value]


def correct_geometry(geometry):
    """Return an aligned copy, preserving every polygon, hole and vertex."""
    if geometry is None:
        return None
    result = deepcopy(geometry)
    if result['type'] == 'GeometryCollection':
        result['geometries'] = [correct_geometry(part) for part in result['geometries']]
    else:
        result['coordinates'] = _coordinates(result['coordinates'])
    if 'bbox' in result:
        result['bbox'] = list(shape(result).bounds)
    return result


def displacement_report(geometry):
    """Measure the contour-centre correction in metres on the WGS84 ellipsoid."""
    before = shape(geometry)
    after = shape(correct_geometry(geometry))
    azimuth, _, distance = _GEOD.inv(
        before.centroid.x, before.centroid.y, after.centroid.x, after.centroid.y
    )
    return {
        'distance_m': round(distance, 4),
        'azimuth_degrees': round(azimuth, 4),
        'before_valid': before.is_valid,
        'after_valid': after.is_valid,
        'geometry_type': after.geom_type,
    }
