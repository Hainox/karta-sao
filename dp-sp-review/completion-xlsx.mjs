import '../object-maps/photo-package.js';

const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const documentRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006';
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const encoder = new TextEncoder();
const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

// Индексы стилей: обычное число, заголовок, итог, процент, процент итога.
const styles = `<styleSheet xmlns="${spreadsheet}">
  <fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF123D33"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7F4EE"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">${[[0, 0, 0], [0, 1, 2], [0, 2, 3], [10, 0, 0], [10, 2, 3]].map(([number, font, fill]) =>
    `<xf numFmtId="${number}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`,
  ).join('')}</cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function worksheet(sheet, headings, asOf) {
  const columns = 'ABCDEFG';
  const rows = [[`Сводка по оцифровке · ${sheet.name}`], [asOf], headings, ...sheet.rows];
  const data = rows.map((values, index) => {
    const number = index + 1;
    const height = index === 0 || index === 2 ? 26 : 19;
    const cells = values.map((value, column) => {
      const style = index === 0 || index === 2 ? 1 : index === 3 ? (column === 6 ? 4 : 2) : (column === 6 ? 3 : 0);
      const key = `r="${columns[column]}${number}" s="${style}"`;
      if (typeof value === 'number') return `<c ${key}><v>${value}</v></c>`;
      return `<c ${key} t="inlineStr"><is><t>${escape(value ?? '—')}</t></is></c>`;
    });
    return `<row r="${number}" ht="${height}" customHeight="1">${cells.join('')}</row>`;
  });
  return `<worksheet xmlns="${spreadsheet}">
    <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
    <cols><col min="1" max="1" width="26" customWidth="1"/><col min="2" max="7" width="16" customWidth="1"/></cols>
    <sheetData>${data.join('')}</sheetData>
    <mergeCells count="2"><mergeCell ref="A1:G1"/><mergeCell ref="A2:G2"/></mergeCells>
  </worksheet>`;
}

export function completionWorkbook({ sheets, headings, asOf }) {
  const relationship = (id, type, target) => `<Relationship Id="${id}" Type="${documentRelationships}/${type}" Target="${target}"/>`;
  const wrapRelationships = entries => `<Relationships xmlns="${packageNamespace}/relationships">${entries.join('')}</Relationships>`;
  const override = (path, type) => `<Override PartName="/xl/${path}" ContentType="${mime}.${type}+xml"/>`;
  const sheetPath = index => `worksheets/sheet${index + 1}.xml`;
  const parts = {
    '[Content_Types].xml': `<Types xmlns="${packageNamespace}/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="${mime}.sheet.main+xml"/>
      ${override('styles.xml', 'styles')}${sheets.map((_, i) => override(sheetPath(i), 'worksheet')).join('')}
    </Types>`,
    '_rels/.rels': wrapRelationships([relationship('rId1', 'officeDocument', 'xl/workbook.xml')]),
    'xl/workbook.xml': `<workbook xmlns="${spreadsheet}" xmlns:r="${documentRelationships}"><bookViews><workbookView/></bookViews><sheets>${sheets.map(
      (sheet, i) => `<sheet name="${escape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    ).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': wrapRelationships([
      ...sheets.map((_, i) => relationship(`rId${i + 1}`, 'worksheet', sheetPath(i))),
      relationship(`rId${sheets.length + 1}`, 'styles', 'styles.xml'),
    ]),
    'xl/styles.xml': styles,
  };
  sheets.forEach((sheet, i) => { parts[`xl/${sheetPath(i)}`] = worksheet(sheet, headings, asOf); });
  const archive = globalThis.SaoPhotoPackage.zip(Object.entries(parts).map(([name, xml]) => ({ name, bytes: encoder.encode(declaration + xml) })));
  return new Blob([archive], { type: `${mime}.sheet` });
}
