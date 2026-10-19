import { readFileSync } from 'node:fs';

export const AVD_OWNER = 'АвД САО';
// Объекты АвД берём из каталога карты: туда входят и ТПУ с парковками исходного Excel,
// и парковки с карманами выгрузки АСУ ОДХ на балансе АвД.
const CATALOG = JSON.parse(readFileSync(new URL('./tpu-objects.json', import.meta.url), 'utf8'));
export const AVD_OBJECTS = new Set(CATALOG.filter((o) => o.group === AVD_OWNER).map((o) => o.id));
export const AVD_OUTSIDE_OBJECT = 'parking:10002419';
export const AVD_OUTSIDE_BOUNDARY = JSON.parse(readFileSync(new URL('./avd-outside-boundary.geojson', import.meta.url), 'utf8'));
