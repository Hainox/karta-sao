function coordinates(lat, lon) {
  if (lat == null || lon == null || lat === '' || lon === '') return null;
  const pair = [Number(lat), Number(lon)];
  return Math.abs(pair[0]) <= 90 && Math.abs(pair[1]) <= 180 ? pair : null;
}

export function captureLocation(row) {
  const angle = Number(row.heading);
  return {
    point: coordinates(row.latitude, row.longitude),
    heading: row.heading != null && row.heading !== '' && Number.isFinite(angle) ? (angle % 360 + 360) % 360 : null,
    gps: coordinates(row.gps_latitude, row.gps_longitude),
  };
}

export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const sin = x => Math.sin(x * rad / 2) ** 2;
  const h = sin(b[0] - a[0]) + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * sin(b[1] - a[1]);
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

// Photos are served as blobs, and old captures can have GPS only in EXIF.
export function photoGps(buffer) {
  try {
    const data = new DataView(buffer);
    const tag = (offset, name) => [...name].every((c, i) => data.getUint8(offset + i) === c.charCodeAt(0));
    let exif;
    if (data.getUint16(0) === 0xffd8) {
      for (let i = 2; i + 4 <= data.byteLength;) {
        const marker = data.getUint16(i);
        if (marker === 0xffda || marker === 0xffd9) break;
        const size = data.getUint16(i + 2);
        if (size < 2 || i + 2 + size > data.byteLength) break;
        if (marker === 0xffe1 && size >= 8 && tag(i + 4, 'Exif\0\0')) {
          exif = new DataView(buffer, i + 10, size - 8);
          break;
        }
        i += 2 + size;
      }
    } else {
      const png = data.getUint32(0) === 0x89504e47 && data.getUint32(4) === 0x0d0a1a0a;
      const webp = !png && tag(0, 'RIFF') && tag(8, 'WEBP');
      if (!png && !webp) return null;
      for (let i = png ? 8 : 12; i + 8 <= data.byteLength;) {
        const size = data.getUint32(i + (png ? 0 : 4), webp);
        const end = i + 8 + size;
        if (end > data.byteLength) break;
        if (tag(i + (png ? 4 : 0), png ? 'eXIf' : 'EXIF')) {
          const prefix = size >= 6 && tag(i + 8, 'Exif\0\0') ? 6 : 0;
          exif = new DataView(buffer, i + 8 + prefix, size - prefix);
          break;
        }
        i = end + (png ? 4 : size % 2);
      }
    }
    if (!exif) return null;
    const order = exif.getUint16(0);
    const le = order === 0x4949;
    const u16 = i => exif.getUint16(i, le);
    const u32 = i => exif.getUint32(i, le);
    if ((!le && order !== 0x4d4d) || u16(2) !== 42) return null;
    const entries = offset => {
      const count = u16(offset);
      if (count > 1024 || offset + 2 + count * 12 > exif.byteLength) return new Map();
      return new Map(Array.from({ length: count }, (_, i) => {
        const at = offset + 2 + i * 12;
        return [u16(at), at];
      }));
    };
    const pointer = entries(u32(4)).get(0x8825);
    if (pointer == null || u16(pointer + 2) !== 4 || u32(pointer + 4) !== 1) return null;
    const gps = entries(u32(pointer + 8));
    const read = (tagId, refId, positive, negative) => {
      const at = gps.get(tagId), ref = gps.get(refId);
      if (at == null || ref == null || u16(at + 2) !== 5 || u32(at + 4) !== 3) return null;
      const direction = String.fromCharCode(exif.getUint8(ref + 8));
      if (![positive, negative].includes(direction)) return null;
      const start = u32(at + 8);
      const ratio = i => u32(start + i) / u32(start + i + 4);
      const value = ratio(0) + ratio(8) / 60 + ratio(16) / 3600;
      return Number.isFinite(value) ? value * (direction === negative ? -1 : 1) : null;
    };
    return coordinates(read(2, 1, 'N', 'S'), read(4, 3, 'E', 'W'));
  } catch { return null; }
}
