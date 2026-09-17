// Выгрузка объектов корневой карты САО в Excel: по районам и участкам.
//
// Данные берутся из тех же слоёв, что нарисованы на карте, поэтому книга и карта
// не расходятся. Участок у большинства слоёв есть в самих данных; там, где он
// пустой (урны, детские и спортивные площадки), участок определяется попаданием
// точки в дворовый участок того же района — иначе эти объекты ушли бы в «Без
// участка» и разрез по участкам потерял бы смысл.
//
// Раскладка книги: сводка по районам, сводка по участкам и отдельный лист на
// каждый район, который можно отдать району как есть.
window.SaoExports = (function () {
  // Порядок слоёв постоянный: он же порядок колонок в сводках.
  const LAYERS = [
    { key: 'areas', title: 'Дворы и участки' },
    { key: 'mno', title: 'МНО' },
    { key: 'dp', title: 'Детские площадки' },
    { key: 'sp', title: 'Спортивные площадки' },
    { key: 'smm_storage', title: 'Места хранения СММ' },
    { key: 'urns', title: 'Урны' }
  ];
  const LAYER_TITLES = Object.fromEntries(LAYERS.map((item) => [item.key, item.title]));
  const LAYER_ORDER = Object.fromEntries(LAYERS.map((item, index) => [item.key, index]));
  const NO_SECTION = 'Без участка';

  const FONT = 'Century Gothic';
  const THIN = { style: 'thin', color: { argb: 'FFB6C4D2' } };
  const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  const CENTERED = { horizontal: 'center', vertical: 'middle' };
  const TO_LEFT = { horizontal: 'left', vertical: 'middle', wrapText: false };
  const WRAPPED = { horizontal: 'left', vertical: 'middle', wrapText: true };
  const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF3' } };
  const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD7E3EC' } };

  /** «5.0», «5», «Участок 5» — один и тот же участок: приводим к «Участок 5». */
  function normalizeSection(value) {
    const text = String(value ?? '').trim();
    if (!text) return NO_SECTION;
    if (/^без\s+участка$/i.test(text)) return NO_SECTION;
    const match = text.match(/^(?:участок\s*)?(\d+)(?:[.,]0+)?$/i);
    return match ? `Участок ${match[1]}` : text;
  }

  function ringsOf(geometry) {
    if (geometry?.type === 'Polygon') return geometry.coordinates || [];
    if (geometry?.type === 'MultiPolygon') return (geometry.coordinates || []).flat();
    return [];
  }

  function boundsOf(rings) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (const position of ring) {
        if (position[0] < minX) minX = position[0];
        if (position[1] < minY) minY = position[1];
        if (position[0] > maxX) maxX = position[0];
        if (position[1] > maxY) maxY = position[1];
      }
    }
    return [minX, minY, maxX, maxY];
  }

  /** Попадание точки в кольцо: считаем пересечения луча, как это делает GIS. */
  function pointInRing(point, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
      const [x1, y1] = ring[index];
      const [x2, y2] = ring[previous];
      if ((y1 > point[1]) === (y2 > point[1])) continue;
      if (point[0] < x1 + ((point[1] - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
    }
    return inside;
  }

  /** Внешнее кольцо — внутри, дырки — снаружи: иначе точка у дырки попадёт в двор. */
  function pointInPolygon(point, rings) {
    if (!rings.length || !pointInRing(point, rings[0])) return false;
    return !rings.slice(1).some((hole) => pointInRing(point, hole));
  }

  /**
   * Участки по районам с рамками. Рамка нужна потому, что объектов десятки тысяч:
   * без неё каждая точка проверялась бы против двух тысяч дворов округа.
   */
  function buildSectionIndex(records) {
    const byDistrict = new Map();
    for (const record of records) {
      if (record.layerKey !== 'areas') continue;
      const section = normalizeSection(record.section);
      if (section === NO_SECTION) continue;
      const rings = ringsOf(record.geometry);
      if (!rings.length) continue;
      if (!byDistrict.has(record.district)) byDistrict.set(record.district, []);
      byDistrict.get(record.district).push({ section, rings, bounds: boundsOf(rings) });
    }
    return byDistrict;
  }

  function sectionByGeometry(point, district, index) {
    const polygons = index.get(district);
    if (!point || !polygons) return NO_SECTION;
    for (const polygon of polygons) {
      const [minX, minY, maxX, maxY] = polygon.bounds;
      if (point[0] < minX || point[0] > maxX || point[1] < minY || point[1] > maxY) continue;
      if (pointInPolygon(point, polygon.rings)) return polygon.section;
    }
    return NO_SECTION;
  }

  /** Центр объекта: у точки — она сама, у контура двора — середина его рамки. */
  function centerOf(geometry) {
    if (geometry?.type === 'Point') return geometry.coordinates;
    const rings = ringsOf(geometry);
    if (!rings.length) return null;
    const [minX, minY, maxX, maxY] = boundsOf(rings);
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  function coordinatesText(point) {
    if (!point) return '';
    return `${point[1].toFixed(5)}, ${point[0].toFixed(5)}`;
  }

  /** Дополнительно: у каждого слоя свои полезные поля — сводим их в одну строку. */
  function extraFor(record) {
    const properties = record.properties || {};
    const parts = [];
    const put = (label, value) => {
      const text = String(value ?? '').trim();
      if (text) parts.push(`${label}: ${text}`);
    };
    if (record.layerKey === 'areas') {
      put('Площадь', properties['Площадь']);
      put('Уборочная', properties['Уборочная']);
      put('Дворник', properties['Дворник (РКУ)']);
      put('Начальник участка', properties['Начальник участка']);
      put('Телефон', properties['Телефон начальника участка']);
      put('Статус', properties['Статус']);
    } else if (record.layerKey === 'mno') {
      put('Тип МНО', properties.mno_type);
      put('Контейнеров', properties.container_count);
      put('Источник адреса', properties.source_address);
    } else if (record.layerKey === 'dp' || record.layerKey === 'sp') {
      put('Тип', properties.type);
      put('Покрытие', properties.site_type);
      put('Год благоустройства', properties.improvement_year);
    } else if (record.layerKey === 'smm_storage') {
      put('Единиц СММ', properties.smm_units);
      put('Назначение', properties.purpose);
      put('Проверка', properties.verification);
    } else if (record.layerKey === 'urns') {
      put('Материал', properties.material);
      put('Статус', properties.status);
      put('Двор', properties.yard);
    }
    return parts.join(' · ');
  }

  function emptyKinds() {
    return Object.fromEntries(LAYERS.map((layer) => [layer.key, 0]));
  }

  function addKinds(target, record) {
    target[record.layerKey] = (target[record.layerKey] || 0) + 1;
  }

  function sectionOrder(section) {
    if (section === NO_SECTION) return 9999;
    const match = String(section).match(/\d+/);
    return match ? Number(match[0]) : 9000;
  }

  function compareText(left, right) {
    return String(left).localeCompare(String(right), 'ru');
  }

  /**
   * Собираем объекты и два разреза: по районам и по участкам внутри района.
   * Участок объекта остаётся видимым в книге — по нему и группируются строки.
   */
  function collect(records) {
    const list = Array.isArray(records) ? records : [];
    const index = buildSectionIndex(list);
    const objects = [];
    const districts = new Map();

    for (const record of list) {
      const district = record.district || 'Без района';
      const fromSource = normalizeSection(record.section);
      const point = centerOf(record.geometry);
      // Урны и площадки приходят без участка: ищем его по геометрии — так же, как
      // это сделал бы человек, глядя на карту.
      const section = fromSource !== NO_SECTION
        ? fromSource
        : sectionByGeometry(record.geometry?.type === 'Point' ? record.geometry.coordinates : point, district, index);

      objects.push({
        district,
        section,
        layerKey: record.layerKey,
        type: LAYER_TITLES[record.layerKey] || record.layerKey,
        name: String(record.name || '').trim(),
        address: String(record.properties?.address || '').trim(),
        coordinates: coordinatesText(point),
        extra: extraFor(record)
      });

      if (!districts.has(district)) {
        districts.set(district, { district, total: 0, kinds: emptyKinds(), sections: new Map() });
      }
      const entry = districts.get(district);
      entry.total += 1;
      addKinds(entry.kinds, record);
      if (!entry.sections.has(section)) {
        entry.sections.set(section, { section, total: 0, kinds: emptyKinds() });
      }
      const sectionEntry = entry.sections.get(section);
      sectionEntry.total += 1;
      addKinds(sectionEntry.kinds, record);
    }

    const rows = [...districts.values()]
      .map((entry) => ({
        ...entry,
        sections: [...entry.sections.values()]
          .sort((left, right) => sectionOrder(left.section) - sectionOrder(right.section) || compareText(left.section, right.section))
      }))
      .sort((left, right) => compareText(left.district, right.district));

    const overall = { total: 0, kinds: emptyKinds() };
    for (const entry of rows) {
      overall.total += entry.total;
      for (const layer of LAYERS) overall.kinds[layer.key] += entry.kinds[layer.key];
    }

    return { objects, districts: rows, overall };
  }

  // ── книга ────────────────────────────────────────────────────────────────

  function safeSheetName(value) {
    return String(value || 'Район')
      .replace(/[[\]:*?/\\]/g, ' ')
      .replace(/^'+|'+$/g, '')
      .trim()
      .slice(0, 31) || 'Район';
  }

  function uniqueSheetName(workbook, name) {
    const base = safeSheetName(name);
    const taken = (candidate) => workbook.worksheets.some((sheet) => sheet.name.toLowerCase() === candidate.toLowerCase());
    let candidate = base;
    for (let suffix = 2; taken(candidate); suffix += 1) {
      const tail = ` (${suffix})`;
      candidate = `${base.slice(0, 31 - tail.length).trim()}${tail}`;
    }
    return candidate;
  }

  function writeTitle(sheet, columns, text) {
    sheet.mergeCells(1, 1, 1, columns);
    const cell = sheet.getCell(1, 1);
    cell.value = text;
    cell.font = { name: FONT, size: 12, bold: true };
    cell.alignment = TO_LEFT;
    cell.fill = HEAD_FILL;
    sheet.getRow(1).height = 22;
  }

  function writeHeader(sheet, rowIndex, columns) {
    columns.forEach(([, width], offset) => {
      const cell = sheet.getCell(rowIndex, offset + 1);
      cell.value = columns[offset][0];
      cell.font = { name: FONT, size: 10, bold: true };
      cell.alignment = CENTERED;
      cell.fill = HEAD_FILL;
      cell.border = BORDER;
      sheet.getColumn(offset + 1).width = width;
    });
  }

  function writeRow(sheet, rowIndex, values, options) {
    const { centered = [], wrap = [], total = false } = options || {};
    values.forEach((value, offset) => {
      const cell = sheet.getCell(rowIndex, offset + 1);
      cell.value = value;
      cell.font = { name: FONT, size: 10, bold: total };
      cell.border = BORDER;
      cell.alignment = centered.includes(offset) ? CENTERED : (wrap.includes(offset) ? WRAPPED : TO_LEFT);
      if (total) cell.fill = TOTAL_FILL;
      if (typeof value === 'number') cell.numFmt = '0';
    });
  }

  function writeNote(sheet, rowIndex, columns, lines) {
    lines.forEach((line, offset) => {
      sheet.mergeCells(rowIndex + offset, 1, rowIndex + offset, columns);
      const cell = sheet.getCell(rowIndex + offset, 1);
      cell.value = line;
      cell.font = { name: FONT, size: 9, italic: true };
      cell.alignment = TO_LEFT;
    });
  }

  /** Сводка по районам: сколько объектов каждого типа и всего — по районам и по САО. */
  function addSummarySheet(workbook, model) {
    const sheet = workbook.addWorksheet('Сводка по районам');
    const columns = [
      ['№', 6], ['Район', 26], ...LAYERS.map((layer) => [layer.title, 20]), ['Всего', 12]
    ];
    writeTitle(sheet, columns.length, 'Объекты САО по районам и участкам');
    writeHeader(sheet, 2, columns);
    const centered = columns.map((_, index) => index).filter((index) => index !== 1);

    model.districts.forEach((entry, index) => {
      writeRow(sheet, index + 3, [
        index + 1, entry.district, ...LAYERS.map((layer) => entry.kinds[layer.key]), entry.total
      ], { centered });
    });

    const totalRow = model.districts.length + 3;
    writeRow(sheet, totalRow, [
      '', 'ИТОГО по САО', ...LAYERS.map((layer) => model.overall.kinds[layer.key]), model.overall.total
    ], { centered, total: true });

    const notes = [
      `Объектов на карте: ${model.overall.total}. Районов: ${model.districts.length}.`,
      'Участок берётся из данных слоя. У урн, детских и спортивных площадок участка в данных нет — его определяет попадание точки в дворовый участок того же района.',
      'Объект, не попавший ни в один двор, остаётся строкой «Без участка»: приписывать его району молча нельзя.'
    ];
    // Данные приходят живыми: часть объектов идёт без района, и лучше сказать об
    // этом строкой, чем оставить в книге молчаливый пробел.
    const withoutDistrict = model.districts.find((entry) => entry.district === 'Без района');
    if (withoutDistrict) {
      notes.push(`Без района: ${withoutDistrict.total} объектов — в источнике район не указан.`);
    }
    writeNote(sheet, totalRow + 2, columns.length, notes);
    sheet.views = [{ state: 'frozen', ySplit: 2 }];
    return sheet;
  }

  /** Сводка по участкам: тот же разрез, но строка — участок внутри района. */
  function addSectionSheet(workbook, model) {
    const sheet = workbook.addWorksheet('По участкам');
    const columns = [
      ['№', 6], ['Район', 24], ['Участок', 16], ...LAYERS.map((layer) => [layer.title, 18]), ['Всего', 12], ['Доля от района, %', 16]
    ];
    writeTitle(sheet, columns.length, 'Объекты по участкам');
    writeHeader(sheet, 2, columns);
    const centered = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    let rowIndex = 3;
    let counter = 0;
    model.districts.forEach((entry) => {
      entry.sections.forEach((section) => {
        counter += 1;
        const share = entry.total ? Math.round((section.total / entry.total) * 1000) / 10 : 0;
        writeRow(sheet, rowIndex, [
          counter, entry.district, section.section,
          ...LAYERS.map((layer) => section.kinds[layer.key]), section.total, share
        ], { centered });
        sheet.getCell(rowIndex, columns.length).numFmt = '0.0"%"';
        rowIndex += 1;
      });
    });

    writeRow(sheet, rowIndex, [
      '', 'ИТОГО по САО', '', ...LAYERS.map((layer) => model.overall.kinds[layer.key]), model.overall.total, 100
    ], { centered, total: true });
    sheet.getCell(rowIndex, columns.length).numFmt = '0.0"%"';

    writeNote(sheet, rowIndex + 2, columns.length, [
      `Участков в книге: ${counter}. Объектов: ${model.overall.total}.`,
      'Доля считается от объектов района: сколько из них приходится на участок.'
    ]);
    sheet.views = [{ state: 'frozen', ySplit: 2 }];
    return sheet;
  }

  /** Лист района: объекты по участкам — его можно отдать району как есть. */
  function addDistrictSheet(workbook, entry, model) {
    const sheet = workbook.addWorksheet(uniqueSheetName(workbook, entry.district));
    const columns = [
      ['№', 6], ['Участок', 16], ['Тип объекта', 22], ['Название', 52], ['Адрес', 38], ['Координаты', 22], ['Дополнительно', 70]
    ];
    writeTitle(sheet, columns.length, `${entry.district}: объекты по участкам`);
    writeHeader(sheet, 2, columns);

    const rows = model.objects
      .filter((object) => object.district === entry.district)
      .sort((left, right) => sectionOrder(left.section) - sectionOrder(right.section)
        || compareText(left.section, right.section)
        || LAYER_ORDER[left.layerKey] - LAYER_ORDER[right.layerKey]
        || compareText(left.name, right.name));

    rows.forEach((object, index) => {
      writeRow(sheet, index + 3, [
        index + 1, object.section, object.type, object.name, object.address, object.coordinates, object.extra
      ], { centered: [0, 1, 5], wrap: [3, 4, 6] });
    });

    const totalRow = rows.length + 3;
    writeRow(sheet, totalRow, [
      '', 'ИТОГО объектов', rows.length, '', '', '', ''
    ], { centered: [0, 2], total: true });

    const withoutSection = rows.filter((object) => object.section === NO_SECTION).length;
    const notes = [`Объектов в районе: ${rows.length}. Участков: ${entry.sections.length}.`];
    if (withoutSection) {
      notes.push(`Без участка: ${withoutSection} — эти объекты не попали ни в один дворовый контур района.`);
    }
    writeNote(sheet, totalRow + 2, columns.length, notes);
    sheet.views = [{ state: 'frozen', ySplit: 2 }];
    return sheet;
  }

  function buildWorkbook(model, ExcelJS) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Городской атлас САО';
    workbook.created = new Date();
    addSummarySheet(workbook, model);
    addSectionSheet(workbook, model);
    for (const entry of model.districts) addDistrictSheet(workbook, entry, model);
    return workbook;
  }

  function todayStamp(value) {
    const date = value ? new Date(value) : new Date();
    const part = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
  }

  function download(buffer, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }));
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  return {
    LAYERS, NO_SECTION,
    normalizeSection, pointInRing, pointInPolygon, buildSectionIndex, sectionByGeometry,
    centerOf, coordinatesText, extraFor, collect, buildWorkbook, download, todayStamp
  };
}());
