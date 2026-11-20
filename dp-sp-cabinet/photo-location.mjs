import { photoGps } from '../districts/review-location.mjs';

const signature = 'SAO-CAPTURE-1\n';

export function cameraDirection(event) {
  if (Number.isFinite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0) {
    return event.webkitCompassHeading % 360;
  }
  if (!event.absolute || ![event.alpha, event.beta, event.gamma].every(Number.isFinite)) return null;
  const [alpha, beta, gamma] = [event.alpha, event.beta, event.gamma].map(angle => angle * Math.PI / 180);
  const east = -Math.cos(alpha) * Math.sin(gamma) - Math.sin(alpha) * Math.sin(beta) * Math.cos(gamma);
  const north = -Math.sin(alpha) * Math.sin(gamma) + Math.cos(alpha) * Math.sin(beta) * Math.cos(gamma);
  return Math.hypot(east, north) > 0.1 ? (Math.atan2(east, north) * 180 / Math.PI + 360) % 360 : null;
}

export function embedPhotoLocation(jpeg, gps, heading) {
  if (!gps && heading == null) return jpeg;
  // Оригинал хранится без перекодирования. JPEG-комментарий сохраняет данные при повторном открытии карточки.
  const payload = new TextEncoder().encode(signature + JSON.stringify({ gps, heading }));
  const size = payload.length + 2;
  const header = Uint8Array.of(0xff, 0xfe, size >> 8, size & 0xff);
  return new Blob([jpeg.slice(0, 2), header, payload, jpeg.slice(2)], { type: 'image/jpeg' });
}

export async function readPhotoLocation(blob) {
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  if (view.byteLength >= 6 && view.getUint32(0) === 0xffd8fffe) {
    const size = view.getUint16(4) - 2;
    if (size > signature.length && size <= 256 && size + 6 <= view.byteLength) {
      const comment = new TextDecoder().decode(new Uint8Array(bytes, 6, size));
      if (comment.startsWith(signature)) {
        try {
          const { gps, heading } = JSON.parse(comment.slice(signature.length));
          return {
            gps: Array.isArray(gps) && gps.length === 2 && gps.every(Number.isFinite) &&
              Math.abs(gps[0]) <= 90 && Math.abs(gps[1]) <= 180 ? gps : null,
            heading: Number.isFinite(heading) && heading >= 0 && heading < 360 ? heading : null,
          };
        } catch {}
      }
    }
  }
  return { gps: photoGps(bytes), heading: null };
}
