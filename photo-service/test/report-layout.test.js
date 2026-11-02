import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {summarizeTpu,buildTpuReport} from '../src/tpu-points/tpu-report.js';
import {summarizeSlots,buildSlotReport} from '../src/tpu-points/slot-report.js';
import {summarizeReview,buildReviewReport} from '../src/review-report.js';
import {summarizeDigitization,buildDigitizationReport} from '../src/digitization-report.js';
import {summarizeDistrictPhotos,buildDistrictPhotosReport} from '../src/tpu-points/district-photo-report.js';
const objects=[{id:'p',kind:'parking',type:'Парковка',label:'Парковка',group:'Аэропорт',district:'Аэропорт',sourceNumber:'1'},{id:'t',kind:'tpu',label:'ТПУ',group:'Аэропорт',sourceNumber:'2'}];
const point={object_key:'p',district:'Аэропорт',label:'1.1',photo_count:1,last_photo_at:'2026-11-02T10:00:00Z',created_at:'2026-11-01T10:00:00Z',latitude:55.8,longitude:37.5};
const cases=[
 ['парковки',()=>buildTpuReport(summarizeTpu({objects,points:[point],kind:'parking'}))],
 ['ТПУ',()=>buildTpuReport(summarizeTpu({objects,points:[],kind:'tpu'}))],
 ['ТПУ и парковки',()=>buildTpuReport(summarizeTpu({objects,points:[point]}))],
 ['слоты',()=>buildSlotReport(summarizeSlots({objects:new Map(objects.map(o=>[o.id,o])),rows:[]}))],
 ['фотофиксация',()=>buildReviewReport(summarizeReview({rows:[{object_key:'s',object_type:'stop',label:'Остановка',district:'Аэропорт',source_ids:['1'],photos:[]}]}))],
 ['районные фото',()=>buildDistrictPhotosReport(summarizeDistrictPhotos({points:[point]}))],
 ...[null,{dp:'Детские площадки',sp:'Спортивные площадки'}].map(kinds=>['оцифровка '+Boolean(kinds),()=>buildDigitizationReport(summarizeDigitization({points:[{district:'Аэропорт',label:'Т1.001',kind:'dp',state:'accepted',lastPhotoAt:'2026-11-02T10:00:00Z'}],kinds}),{title:'Свод',note:'Пояснение',kinds})])
];
for(const [name,build] of cases)test(name+': без последнего фото, ячейки по центру, ссылки на месте',async()=>{
 const book=new ExcelJS.Workbook();await book.xlsx.load(await build());
 for(const sheet of book.worksheets){sheet.eachRow(row=>row.eachCell(cell=>{assert.notEqual(cell.value,'Последнее фото');assert.equal(cell.alignment.horizontal,'center',sheet.name);assert.equal(cell.alignment.vertical,'middle',sheet.name)}));
 for(const row of [1,3,4]){const h=sheet.getRow(row);h.eachCell((cell,col)=>{if(['На карте','Карта района'].includes(cell.value)&&sheet.rowCount>row){const link=sheet.getRow(row+1).getCell(col).value;if(link)assert.ok(link.hyperlink,'ссылка в колонке карты')}})}
 }
});
