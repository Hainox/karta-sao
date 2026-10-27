import test from 'node:test';import assert from 'node:assert/strict';
import {parseFeature,stableId} from '../scripts/playground-seed-lib.js';
const f={type:'Feature',properties:{source_row:1,source_id:'123',parent_object_name:'Адрес'},
geometry:{type:'Point',coordinates:[37.5,55.8]}};
test('устойчивый ключ и один объект для одной строки',()=>{let p=parseFeature(f,'aeroport','dp');assert.equal(p.sourceKey,'aeroport:1');assert.equal(p.id,stableId('aeroport:1'));assert.equal(p.kind,'dp');});
test('повторный ID в разных строках не уничтожает площадки',()=>{let a=parseFeature(f,'aeroport','dp'),b=parseFeature({...f,properties:{...f.properties,source_row:2}},'aeroport','dp');assert.notEqual(a.id,b.id);});
test('плохие координаты и неправильный район отклоняются',()=>{assert.throws(()=>parseFeature({...f,geometry:{type:'Point',coordinates:[999,55]}},'aeroport','dp'));assert.throws(()=>parseFeature(f,'unknown','dp'));});
