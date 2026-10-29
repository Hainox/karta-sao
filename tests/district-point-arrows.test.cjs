const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../work/district_page_template.html'),'utf8');
const markerFunction=source.slice(source.indexOf('  function pointMarkerElement('),source.indexOf('  /** Правка ручками на карте'));
function marker(heading,preview=false){
  const element=()=>({children:[],dataset:{},style:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(){},append(child){this.children.push(child);}});
  const context={document:{createElement:element,createElementNS:element}};
  vm.createContext(context);vm.runInContext(markerFunction+'\nglobalThis.marker=pointMarkerElement;',context);
  return context.marker({label:'1.1',heading},preview);
}
for(const heading of [0,90,180,270])test('отображается сохранённое направление '+heading+'°',()=>{
  const m=marker(heading);assert.equal(m.children.length,1,'у точки должна быть стрелка');
  assert.equal(m.children[0].style.transform,'rotate('+heading+'deg)');
});
test('неизвестное направление не выдаётся за север',()=>{assert.equal(marker(null).children.length,0);assert.equal(marker(undefined).children.length,0);assert.equal(marker(NaN).children.length,0);});
test('выбранное направление видно в черновике до ответа сервера',()=>{assert.equal(marker(90,true).children[0]?.style.transform,'rotate(90deg)');});
