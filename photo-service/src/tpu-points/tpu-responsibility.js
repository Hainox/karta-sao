import { readFileSync } from 'node:fs';

export const AVD_OWNER = 'АвД САО';
export const AVD_OBJECTS = new Set(["tpu:800905601", "tpu:1331614005", "tpu:757159046", "tpu:314892354", "tpu:10002406", "tpu:10002414", "tpu:667006150", "tpu:314903749", "tpu:751086786", "tpu:666849395", "parking:12344846", "parking:10002419"]);
export const AVD_OUTSIDE_OBJECT = 'parking:10002419';
export const AVD_OUTSIDE_BOUNDARY = JSON.parse(readFileSync(new URL('./avd-outside-boundary.geojson', import.meta.url), 'utf8'));
