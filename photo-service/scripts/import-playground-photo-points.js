// Сухой прогон по умолчанию. --apply добавляет отсутствующие точки и один слот,
// не обновляя и не удаляя имеющиеся записи. Требуется выполнить миграцию отдельно.
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadPoints } from './playground-seed-lib.js';
const here=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
const sourceArg=args.find(x=>x.startsWith('--source='));
if(args.some(x=>x!=='--apply'&&!x.startsWith('--source=')) || args.filter(x=>x.startsWith('--source=')).length>1) throw new Error('Допустимы --apply и --source=/path/to/districts/layers');
const sourceRoot=sourceArg ? resolve(sourceArg.slice('--source='.length)) : resolve(here,'../../districts/layers');
const records=await loadPoints(sourceRoot);
const summary={points:records.length,slots:records.length,children:records.filter(x=>x.kind==='dp').length,
  sport:records.filter(x=>x.kind==='sp').length,apply:args.includes('--apply')};
if(!summary.apply){console.log(JSON.stringify(summary,null,2));process.exit(0);}
const {Pool}=await import('pg');
const {photoServiceDatabaseConfig}=await import('../src/config.js');
const pool=new Pool({...photoServiceDatabaseConfig(process.env),max:1});
let c;
try {
 c=await pool.connect();await c.query('BEGIN');
 let inserted=0,skipped=0,slots=0;
 for(const p of records){
  const r=await c.query(`INSERT INTO playground_photo_points
    (id,source_key,source_row,source_id,district_code,district,kind,address,longitude,latitude,source_properties)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (source_key) DO NOTHING RETURNING id`,
    [p.id,p.sourceKey,p.sourceRow,p.sourceId,p.districtCode,p.district,p.kind,p.address,p.longitude,p.latitude,JSON.stringify(p.properties)]);
  if(r.rowCount)inserted++;else skipped++;
  const found=await c.query('SELECT id FROM playground_photo_points WHERE source_key=$1',[p.sourceKey]);
  if(!found.rows[0]||found.rows[0].id!==p.id)throw new Error('Несовпадение стабильного ID: '+p.sourceKey);
  const slot=await c.query('INSERT INTO playground_photo_slots(point_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING point_id',[p.id]);
  slots+=slot.rowCount;
 }
 await c.query('COMMIT');console.log(JSON.stringify({...summary,inserted,skipped,slotsCreated:slots},null,2));
} catch(e){if(c)await c.query('ROLLBACK');throw e;} finally {if(c)c.release();await pool.end();}
