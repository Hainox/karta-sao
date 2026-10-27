import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
export const DISTRICTS = {
  aeroport:'Аэропорт',begovoy:'Беговой',beskudnikovskiy:'Бескудниковский',
  voykovskiy:'Войковский','vostochnoe-degunino':'Восточное Дегунино',
  golovinskiy:'Головинский',dmitrovskiy:'Дмитровский','zapadnoe-degunino':'Западное Дегунино',
  koptevo:'Коптево',levoberezhnyy:'Левобережный',molzhaninovskiy:'Молжаниновский',
  savelovskiy:'Савеловский',sokol:'Сокол',timiryazevskiy:'Тимирязевский',
  hovrino:'Ховрино',horoshevskiy:'Хорошевский'
};
export function stableId(key) {
  const bytes=createHash('sha256').update('sao-playground-photo-point-v1:'+key).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|0x50; bytes[8]=(bytes[8]&63)|0x80;
  const h=bytes.toString('hex');return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
}
export function parseFeature(feature, slug, kind) {
  const p=feature?.properties||{}, coords=feature?.geometry?.coordinates, row=Number(p.source_row);
  if (!DISTRICTS[slug] || !['dp','sp'].includes(kind)) throw new Error('Неизвестный район или тип');
  if (feature?.geometry?.type!=='Point' || !Array.isArray(coords) || coords.length!==2 || !coords.every(Number.isFinite)
      || coords[0]<36 || coords[0]>39 || coords[1]<55 || coords[1]>57) throw new Error('Неверные координаты');
  if (!Number.isSafeInteger(row)||row<1||!/^[0-9]+$/.test(String(p.source_id||''))) throw new Error('Неверный номер строки или ID');
  const sourceKey=slug+':'+row;
  return {id:stableId(sourceKey),sourceKey,sourceRow:row,sourceId:String(p.source_id),districtCode:slug,
    district:DISTRICTS[slug],kind,address:String(p.parent_object_name||''),longitude:coords[0],latitude:coords[1],properties:p};
}
export async function loadPoints(root) {
  const records=[], keys=new Set(), ids=new Set();
  for (const slug of Object.keys(DISTRICTS)) for (const kind of ['dp','sp']) {
    const fc=JSON.parse(await readFile(resolve(root,slug,kind+'_table.geojson'),'utf8'));
    if (fc.type!=='FeatureCollection'||!Array.isArray(fc.features)) throw new Error('Неверный GeoJSON: '+slug+'/'+kind);
    for(const f of fc.features){const p=parseFeature(f,slug,kind);if(keys.has(p.sourceKey)||ids.has(p.id))throw new Error('Повтор ключа: '+p.sourceKey); keys.add(p.sourceKey);ids.add(p.id);records.push(p);}
  }
  return records;
}
