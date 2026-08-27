import fs from 'node:fs/promises';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const out = 'C:/Users/root/Documents/Codex/2026-08-24/odh-yandex-export-tool/outputs/САО_зимний_чек-лист_СММ_2026-2027.xlsx';
const wb = Workbook.create();
const districts = ['Аэропорт','Беговой','Бескудниковский','Войковский','Восточное Дегунино','Головинский','Дмитровский','Западное Дегунино','Коптево','Левобережный','Молжаниновский','Савеловский','Сокол','Тимирязевский','Ховрино','Хорошевский'];
const navy='#12324A', teal='#0D827C', pale='#EAF7F4', amber='#FFF4D6', red='#FCE8E6', line='#D7E1E1';
const styleTitle=(sheet,range,title,subtitle)=>{ sheet.mergeCells(range); const c=sheet.getRange(range); c.values=[[`${title}\n${subtitle}`]]; c.format={fill:navy,font:{color:'#FFFFFF',bold:true,size:16},horizontalAlignment:'left',verticalAlignment:'center',wrapText:true}; c.format.rowHeight=44; };
const header=(sheet,range)=>{ const r=sheet.getRange(range); r.format={fill:teal,font:{color:'#FFFFFF',bold:true},wrapText:true,horizontalAlignment:'center',verticalAlignment:'center',borders:{preset:'all',style:'thin',color:line}}; r.format.rowHeight=30; };
const base=(sheet,range)=>{ const r=sheet.getRange(range); r.format={verticalAlignment:'top',wrapText:true,borders:{preset:'all',style:'thin',color:line}}; };

const chk=wb.worksheets.add('Чек-лист по участкам'); chk.showGridLines=false;
styleTitle(chk,'A1:M2','Зимний чек-лист САО — СММ и готовность участков','Заполняется перед сезоном и далее по каждой контрольной дате. СММ: средства малой механизации.');
chk.getRange('A4:M4').values=[['Район','Участок / адрес','Дата контроля','Ответственный на участке','СММ: наличие и исправность','Бензин: заказан','Бензин: развезён','Реагент: наличие','Реагент: развезён','Лопаты: исправность','Место хранения СММ','Проблема / заявка','Статус']]; header(chk,'A4:M4');
const rows=districts.map(d=>[d,'','','','Не проверено','Не проверено','Не проверено','Не проверено','Не проверено','Не проверено','','','Не начато']);
chk.getRange(`A5:M${4+rows.length}`).values=rows; base(chk,`A5:M${4+rows.length}`); chk.freezePanes.freezeRows(4);
for(const col of ['E','F','G','H','I','J']) chk.getRange(`${col}5:${col}${4+rows.length}`).dataValidation={rule:{type:'list',values:['Не проверено','Готово','Есть замечание','Не требуется']}};
chk.getRange(`M5:M${4+rows.length}`).dataValidation={rule:{type:'list',values:['Не начато','В работе','Готово','Риск']}};
chk.getRange(`C5:C${4+rows.length}`).setNumberFormat('yyyy-mm-dd');
[['A',21],['B',28],['C',13],['D',25],['E',22],['F',16],['G',16],['H',16],['I',16],['J',19],['K',28],['L',30],['M',14]].forEach(([c,w])=>chk.getRange(`${c}:${c}`).format.columnWidth=w);
chk.getRange(`A5:M${4+rows.length}`).format.rowHeight=36;
chk.getRange('O1:P5').values=[['Сводка','Количество'],['Всего участков',`=COUNTA(A5:A${4+rows.length})`],['Готово',`=COUNTIF(M5:M${4+rows.length},"Готово")`],['В работе',`=COUNTIF(M5:M${4+rows.length},"В работе")`],['Риск',`=COUNTIF(M5:M${4+rows.length},"Риск")`]];
chk.getRange('O1:P1').format={fill:teal,font:{color:'#FFFFFF',bold:true},borders:{preset:'all',style:'thin',color:line}}; base(chk,'O2:P5'); chk.getRange('O1:P5').format.columnWidth=17;

const storage=wb.worksheets.add('Места хранения СММ'); storage.showGridLines=false;
styleTitle(storage,'A1:J2','Реестр мест хранения СММ','Карту дополнять только после ввода адреса или координат и назначения ответственного.');
storage.getRange('A4:J4').values=[['№','Район','Адрес / ориентир','Координаты','Тип хранения','СММ и количество','Состояние','Ответственный','Дата сверки','Примечание']]; header(storage,'A4:J4');
storage.getRange('A5:J20').values=districts.map((d,i)=>[i+1,d,'','','Не указано','','Не проверено','','','']); base(storage,'A5:J20'); storage.freezePanes.freezeRows(4);
storage.getRange('E5:E20').dataValidation={rule:{type:'list',values:['Контейнер','Склад','Гараж','Навес','Не указано']}};
storage.getRange('G5:G20').dataValidation={rule:{type:'list',values:['Не проверено','Исправно','Есть замечание','Не пригодно']}};
storage.getRange('I5:I20').setNumberFormat('yyyy-mm-dd');
[['A',7],['B',21],['C',32],['D',19],['E',17],['F',26],['G',17],['H',26],['I',14],['J',35]].forEach(([c,w])=>storage.getRange(`${c}:${c}`).format.columnWidth=w); storage.getRange('A5:J20').format.rowHeight=32;

const questions=wb.worksheets.add('Вопросы и контроль'); questions.showGridLines=false;
styleTitle(questions,'A1:G2','Контрольные вопросы на зимний период','Вопрос задаёт назначенный координатор; подтверждение — фото, накладная, заявка или акт.');
questions.getRange('A4:G4').values=[['Блок','Контрольный вопрос','Кому задаётся','Периодичность','Подтверждение','Приоритет','Статус']]; header(questions,'A4:G4');
const q=[
['СММ','Где хранится СММ? Указаны адрес, тип хранения и ответственный?','Начальник участка','До начала сезона; далее при изменении','Адрес в реестре, фото места','Высокий','Не начато'],
['СММ','Вся СММ исправна? Что сломано и какой срок ремонта?','Начальник участка / механик','Еженедельно','Фото, заявка на ремонт','Высокий','Не начато'],
['ГСМ','Заказан бензин для СММ в требуемом объёме?','Ответственный за ГСМ','Еженедельно до снегопада','Заявка / накладная','Высокий','Не начато'],
['ГСМ','Бензин развезён по участкам; остаток достаточен?','Начальник участка','После развоза / ежедневно при работе','Накладная, отметка участка','Высокий','Не начато'],
['Реагент','Реагент доставлен по участкам; есть ли дефицит?','Начальник участка / склад','Ежедневно в период работ','Накладная, остаток','Высокий','Не начато'],
['Инвентарь','Лопаты и ручной инвентарь исправны; что требует ремонта/замены?','Начальник участка','Еженедельно','Фото, заявка','Средний','Не начато'],
['Персонал','Кто дежурит, кто замещает ответственного?','Начальник участка','Перед сменой','График дежурств','Высокий','Не начато'],
['Риски','Какие объекты/участки не готовы и что требуется для устранения?','Начальник участка','Ежедневно при неблагоприятной погоде','Заявка, срок, ответственный','Высокий','Не начато'],
];
questions.getRange(`A5:G${4+q.length}`).values=q; base(questions,`A5:G${4+q.length}`); questions.freezePanes.freezeRows(4);
questions.getRange(`F5:F${4+q.length}`).dataValidation={rule:{type:'list',values:['Высокий','Средний','Низкий']}}; questions.getRange(`G5:G${4+q.length}`).dataValidation={rule:{type:'list',values:['Не начато','В работе','Готово','Риск']}};
[['A',16],['B',52],['C',28],['D',26],['E',30],['F',14],['G',14]].forEach(([c,w])=>questions.getRange(`${c}:${c}`).format.columnWidth=w); questions.getRange(`A5:G${4+q.length}`).format.rowHeight=48;

const owners=wb.worksheets.add('Ответственные'); owners.showGridLines=false;
styleTitle(owners,'A1:F2','Ответственные и распределение вопросов','Роли и участки уточняются руководителем до включения в публичную карту.');
owners.getRange('A4:F4').values=[['ФИО','Ссылка ТДМ','Роль в зимнем контроле','Закреплённый район / участок','Круг вопросов','Статус назначения']]; header(owners,'A4:F4');
owners.getRange('A5:F6').values=[
['Дмитрий Мичурин','https://web.tdm.mos.ru/im/home/3268776135116206','Уточнить роль','Уточнить','СММ, ГСМ, реагент, инвентарь','Ожидает назначения'],
['Александр Захаров','https://web.tdm.mos.ru/im/home/3268776135116206','Уточнить роль','Уточнить','СММ, ГСМ, реагент, инвентарь','Ожидает назначения'],
]; base(owners,'A5:F6'); owners.getRange('F5:F6').dataValidation={rule:{type:'list',values:['Ожидает назначения','Назначен','Не назначен']}};
[['A',24],['B',54],['C',26],['D',30],['E',36],['F',22]].forEach(([c,w])=>owners.getRange(`${c}:${c}`).format.columnWidth=w); owners.getRange('A5:F6').format.rowHeight=42;
owners.getRange('A8:F9').merge(); owners.getRange('A8:F9').values=[['Внимание: по предоставленной ссылке не удалось подтвердить роли, районы или координаты; поэтому персоналии не добавлены на публичную карту и не привязаны к точкам до вашего подтверждения.']]; owners.getRange('A8:F9').format={fill:amber,font:{color:'#6B4E00',italic:true},wrapText:true,verticalAlignment:'center',borders:{preset:'outside',style:'thin',color:'#E8C873'}};

for (const sheet of [chk,storage,questions,owners]) { sheet.getUsedRange().format.font={name:'Arial',size:10,color:'#1D3342'}; }
await fs.mkdir('C:/Users/root/Documents/Codex/2026-08-24/odh-yandex-export-tool/outputs',{recursive:true});
const file=await SpreadsheetFile.exportXlsx(wb); await file.save(out);
const preview=await wb.render({sheetName:'Чек-лист по участкам',range:'A1:P20',scale:1.4,format:'png'}); await fs.writeFile('C:/Users/root/Downloads/КАРТА/work_smm_checklist/checklist_preview.png',new Uint8Array(await preview.arrayBuffer()));
console.log(out);
