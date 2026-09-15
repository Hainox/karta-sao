import ExcelJS from 'exceljs';

const path = process.argv[2];
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(path);

console.log('листы:', workbook.worksheets.map((sheet) => `${sheet.name}(${sheet.rowCount})`).join(', '));
for (const sheet of workbook.worksheets) {
  console.log(`\n=== ${sheet.name} ===`);
  sheet.eachRow((row, index) => {
    if (sheet.rowCount > 8 && index > 6) return;
    console.log(row.values.slice(1).map((value) => String(value ?? '')).join(' | '));
  });
  if (sheet.rowCount > 8) console.log(`... ещё ${sheet.rowCount - 6} строк`);
}
