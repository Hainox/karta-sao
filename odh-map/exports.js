/* Выгрузки с карты ОДХ: реестр, отчёт по маршрутам и таблица на штаб.
 *
 * Модуль чистый: он не знает ни про карту, ни про сеть — только превращает уже
 * загруженные слои в таблицы, CSV и книгу Excel. Так его можно проверять в
 * изоляции, а загрузка слоёв и кнопки живут в index.html.
 *
 * Единица счёта — точка (геометрическая часть), а не уникальный объект: у одного
 * объекта ОДХ бывает несколько частей, и убирают каждую. Вторая единица — объект
 * по ID из реестра — показывается рядом, но план и процент считаются по точкам.
 * Это то же правило, что в выгрузках фотофиксации, иначе числа расходятся.
 */
(function () {
  'use strict';

  // Объекты владельца «АвД САО» стоят в разных районах, поэтому в отчётности они
  // идут отдельной строкой, а не за районом площадки. Правило одно на все файлы.
  const AUTODOR_HOLDER = 'АвД САО';

  const DISTRICT_NAMES = Object.freeze([
    'Аэропорт', 'Беговой', 'Бескудниковский', 'Войковский', 'Восточное Дегунино',
    'Головинский', 'Дмитровский', 'Западное Дегунино', 'Коптево', 'Левобережный',
    'Молжаниновский', 'Савеловский', 'Сокол', 'Тимирязевский', 'Ховрино', 'Хорошевский'
  ]);

  // Слои карты с правилами учёта. Подтверждение источника — не «есть в файле», а
  // прямая ссылка на официальный документ или сайт: по координатам-кандидатам
  // (геокодер, центроид адреса) штаб решение принимать не может.
  // idLabel объясняет, что именно считает вторая единица счёта: одно поле — один
  // объект. Суммы атрибутов (контейнеры ПГМ, единицы СММ) сюда не выносятся:
  // в слое они не совпадают с числами реестра, и в выгрузке это читалось бы как
  // расхождение, а не как разные единицы измерения.
  const LAYERS = Object.freeze([
    {
      key: 'queue1', sheet: 'ОДХ I очередь', title: 'ОДХ · I очередь',
      objectId: 'id', idLabel: 'идентификатор ОДХ', holder: 'customer', queue: 'I очередь',
      confirmed: (p) => p.status === 'Утвержден',
      source: (p) => p.queue_source
    },
    {
      key: 'queue2', sheet: 'ОДХ II очередь', title: 'ОДХ · II очередь',
      objectId: 'id', idLabel: 'идентификатор ОДХ', holder: 'customer', queue: 'II очередь',
      confirmed: (p) => p.status === 'Утвержден',
      source: (p) => p.queue_source
    },
    {
      key: 'queue3', sheet: 'ОДХ III очередь', title: 'ОДХ · III очередь',
      objectId: 'id', idLabel: 'идентификатор ОДХ', holder: 'customer', queue: 'III очередь',
      confirmed: (p) => p.status === 'Утвержден',
      source: (p) => p.queue_source
    },
    {
      key: 'pgm', sheet: 'Контейнеры ПГМ', title: 'Контейнеры ПГМ',
      objectId: 'odh_id', idLabel: 'идентификатор ОДХ привязки', holder: 'institution',
      confirmed: (p) => p.geometry_status !== 'odh_geometry_proxy',
      source: () => 'Адресный перечень ПГМ'
    },
    {
      key: 'smm_storage', sheet: 'Хранение СММ', title: 'Места хранения СММ',
      objectId: 'name', idLabel: 'название площадки', holder: 'district',
      confirmed: (p) => !/требуется служебная сверка/i.test(String(p.verification || p.coordinate_status || '')),
      source: (p) => p.source
    },
    {
      key: 'snow', sheet: 'Снег — складирование', title: 'Места временного складирования снега',
      objectId: 'address', idLabel: 'адрес', holder: 'district',
      confirmed: (p) => p.geocode_status !== 'candidate',
      source: (p) => (p.source_period ? `Источник ${p.source_period}` : '')
    },
    {
      key: 'dry_snow', sheet: 'Сухие свалки снега', title: 'Сухие свалки снега',
      objectId: 'address', idLabel: 'адрес', holder: null,
      confirmed: (p) => /^подтверждено/i.test(String(p.verification_status || '')),
      source: (p) => p.official_evidence
    },
    {
      key: 'healthcare', sheet: 'Здравоохранение', title: 'Учреждения здравоохранения',
      objectId: 'address', idLabel: 'адрес', holder: null,
      confirmed: (p) => /^подтверждено/i.test(String(p.verification_status || '')),
      source: (p) => p.official_source
    },
    {
      key: 'healthcare_review', sheet: 'Здравоохранение — уточнение',
      title: 'Здравоохранение: адрес на уточнении',
      objectId: 'address', idLabel: 'адрес', holder: null, hidden: true,
      confirmed: () => false,
      source: (p) => p.official_source
    },
    {
      key: 'hydrants', sheet: 'Пожарные гидранты', title: 'Пожарные гидранты',
      objectId: 'address', idLabel: 'адрес', holder: 'organization',
      confirmed: (p) => !/требуется служебная сверка/i.test(String(p.coordinate_status || '')),
      source: () => 'Адресный центроид ArcGIS'
    }
  ]);

  // Категории штабной таблицы плюс «Итого». Одна модель на лист, комментарий и
  // печатную форму, чтобы числа в разных файлах не расходились. commentTitle —
  // та же категория в строке комментария: заголовок блока для письма тяжёлый.
  const GROUPS = Object.freeze([
    { key: 'odh', title: 'ОДХ: I–III очереди', commentTitle: 'ОДХ', layers: ['queue1', 'queue2', 'queue3'] },
    { key: 'pgm', title: 'Контейнеры ПГМ', commentTitle: 'контейнеры ПГМ', layers: ['pgm'] },
    {
      key: 'other', title: 'Прочие объекты карты', commentTitle: 'прочие объекты карты',
      layers: ['smm_storage', 'snow', 'dry_snow', 'healthcare', 'healthcare_review', 'hydrants']
    }
  ]);

  const SOURCE_COLUMNS = Object.freeze(['Район', 'Подтверждено', 'Источник']);
  const HEADQUARTERS_FONT = 'Century Gothic';
  const HEADQUARTERS_INK = 'FF1F3B57';
  const HEADQUARTERS_MUTED = 'FF708089';
  const HEADQUARTERS_DIRECTION = 'Готовность слоёв карты ОДХ';
  const HEADQUARTERS_NOTE = 'Колонка «Объекты» — точки на карте, которые нужно отработать: у одного объекта ОДХ бывает несколько геометрических частей. Колонка «Факт» — точки, подтверждённые официальным источником, а не просто показанные на карте. Объекты с балансодержателем «АвД САО», «ДЭУ» и объекты без района учтены в строке «АвД САО». Процент считается по точкам каждой категории отдельно.';

  // Срез единой базы: то, что районы нарисовали в редакторе и отправили. Это не
  // то же самое, что слои карты, поэтому блок идёт отдельной таблицей внутри
  // сводки на штаб, а не подмешивается в категории выше.
  //
  // Заказчику сейчас нужен приоритет — маршруты уборки и роторные перекидки,
  // поэтому они считаются отдельными колонками. Остальные девять типов держать
  // на листе незачем: они сворачиваются в «Прочие объекты», а их состав
  // перечисляется в примечании, чтобы строка читалась без пояснений.
  const BASE_TITLE = 'Объекты районов в единой базе';
  const PRIORITY_TYPES = Object.freeze([
    { key: 'queue', title: 'Маршруты уборки' },
    { key: 'rotor_transfer', title: 'Роторные перекидки' }
  ]);
  const BASE_EMPTY = 'Данные единой базы не загружены: подключитесь к сервису ОДХ и повторите выгрузку.';

  /** Шапка блока: одна на лист, письмо и печатную форму. */
  function baseColumns() {
    return [
      '№', 'Район', ...PRIORITY_TYPES.map((type) => type.title), 'Прочие объекты',
      'Всего', 'На приёмке', 'Утверждено', 'Отклонено', 'Последняя отправка'
    ];
  }

  /**
   * Название типа берём из district-changes.js — одного словаря на редактор
   * района, приёмку и эту выгрузку. Ключ оставляем запасным вариантом: если район
   * пришлёт тип, которого ещё нет в словаре, строка не пропадёт.
   */
  function typeLabel(key) {
    const types = window.DistrictChanges && window.DistrictChanges.TYPES;
    return (types && types[key] && types[key].label) || key;
  }

  /** Вид объекта по общему словарю: маршрут, зона или точка. */
  function groupOfType(key) {
    const types = window.DistrictChanges && window.DistrictChanges.TYPES;
    return (types && types[key] && types[key].group) || 'point';
  }

  // Тот же лист «На штаб», что у фотофиксации, но для отчёта по маршрутам: три
  // вида объектов в блоках и «Итого». «Объекты» — сколько районы нарисовали и
  // отправили, «Факт» — сколько из этого утверждено приёмкой.
  const ROUTE_GROUPS = Object.freeze([
    { key: 'route', title: 'Маршруты', commentTitle: 'маршруты' },
    { key: 'zone', title: 'Зоны', commentTitle: 'зоны' },
    { key: 'point', title: 'Точки', commentTitle: 'точки' }
  ]);
  const ROUTE_DIRECTION = 'Приёмка маршрутов ОДХ';

  /** Пустые счётчики по видам: план и факт для каждого блока листа «На штаб». */
  const kindsBlank = () => Object.fromEntries(ROUTE_GROUPS.map((group) => [group.key, { plan: 0, fact: 0 }]));
  const ROUTE_NOTE = 'Колонка «Объекты» — сколько объектов района нарисовали в редакторе и отправили в единую базу, независимо от решения приёмки. Колонка «Факт» — сколько из них утверждено; процент считается по объектам каждого вида отдельно. Зоны и точки приёмка не разбирает построчно: в сводке службы «На приёмке», «Утверждено» и «Отклонено» считают только маршруты, поэтому здесь числа по ним идут отдельными колонками, а состояния приёмки названы в комментарии.';

  // Светофор процентов: бледные заливки, смысл несёт число. Пороги те же, что у
  // полосы статуса в других выгрузках заказчика. Отдельный цвет у точного нуля.
  const BAND_FILLS = Object.freeze({
    zero: 'FFEA9999', low: 'FFF4CCCC', middle: 'FFFFF2CC', high: 'FFD9EAD3'
  });

  const CENTERED = Object.freeze({ horizontal: 'center', vertical: 'middle' });
  const TO_LEFT = Object.freeze({ horizontal: 'left', vertical: 'middle' });
  const THIN_BORDER = Object.freeze({ style: 'thin', color: { argb: 'FF000000' } });
  const CELL_BORDER = Object.freeze({
    top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER
  });

  function solidFill(argb) {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  }

  /** Заливка процента: та же градация, что в правилах условного форматирования. */
  function percentBandFill(value, plan) {
    if (!plan || plan <= 0) return 'FFFFFFFF';
    if (value <= 0) return BAND_FILLS.zero;
    if (value < 33) return BAND_FILLS.low;
    if (value < 66) return BAND_FILLS.middle;
    return BAND_FILLS.high;
  }

  /** Процент всегда целым числом: без плана это ноль, а не пустая ячейка. */
  function percent(fact, plan) {
    return plan ? Math.round((fact / plan) * 100) : 0;
  }

  /**
   * Район строки отчёта по балансодержателю слоя. В источниках названия разные:
   * «Жилищник Беговой», «ГБУ «Жилищник района Беговой»», просто «Беговой». Всё,
   * что не разобралось, уходит в строку «АвД САО»: приписать объект чужому
   * району хуже, чем показать его отдельно.
   */
  function districtOf(holder) {
    const value = String(holder == null ? '' : holder).trim();
    if (!value) return AUTODOR_HOLDER;
    if (/авд|автомобильные дороги/i.test(value) || /^дэу/i.test(value)) return AUTODOR_HOLDER;
    const named = value
      .replace(/^ГБУ\s*/i, '')
      .replace(/[«»"]/g, '')
      .replace(/^Жилищник(а)? района\s+/i, '')
      .replace(/^Жилищник\s+/i, '')
      .replace(/\s+района$/i, '')
      .trim();
    return DISTRICT_NAMES.includes(named) ? named : AUTODOR_HOLDER;
  }

  function layerByKey(key) {
    return LAYERS.find((layer) => layer.key === key) || null;
  }

  /** Точки, подтверждённые точки и уникальные объекты по ID. */
  function countOf(layer, features) {
    const list = Array.isArray(features) ? features : [];
    const ids = new Set();
    let confirmed = 0;
    for (const feature of list) {
      const properties = feature.properties || {};
      if (layer.confirmed(properties)) confirmed += 1;
      const id = properties[layer.objectId];
      ids.add(id === null || id === undefined || id === '' ? `точка-${ids.size + 1}` : String(id));
    }
    return { plan: list.length, fact: confirmed, objects: ids.size };
  }

  /** Срез слоя: строка на каждую точку плюс счётчики слоя. */
  function sliceLayer(key, features) {
    const layer = layerByKey(key);
    const list = Array.isArray(features) ? features : [];
    const rows = list.map((feature) => {
      const properties = feature.properties || {};
      return {
        district: districtOf(layer.holder ? properties[layer.holder] : null),
        confirmed: layer.confirmed(properties) ? 'да' : 'нет',
        source: String(layer.source(properties) || '').trim(),
        properties
      };
    });
    return { key, layer, rows, counts: countOf(layer, list) };
  }

  function groupOfLayer(key) {
    return GROUPS.find((group) => group.layers.includes(key)) || GROUPS[0];
  }

  /**
   * Модель выгрузки: слои, категории, районы, итоги и отстающие. Одна модель на
   * все файлы — иначе таблица на штаб и реестр показывают разные числа.
   */
  function collect(layerData) {
    const slices = LAYERS
      .filter((layer) => layerData && layerData[layer.key])
      .map((layer) => sliceLayer(layer.key, layerData[layer.key].features));

    // Районы без объектов тоже обязаны попасть в отчёт: пустая строка читается
    // как «работы нет», а отсутствующая строка — как «район не учли».
    const names = [...DISTRICT_NAMES];
    if (slices.some((slice) => slice.rows.some((row) => row.district === AUTODOR_HOLDER))) {
      names.push(AUTODOR_HOLDER);
    }

    const emptyCounts = () => Object.fromEntries(GROUPS.map((group) => [group.key, { plan: 0, fact: 0 }]));
    const districts = names.map((name) => {
      const counts = emptyCounts();
      for (const slice of slices) {
        const key = groupOfLayer(slice.key).key;
        for (const row of slice.rows) {
          if (row.district !== name) continue;
          counts[key].plan += 1;
          if (row.confirmed === 'да') counts[key].fact += 1;
        }
      }
      return { name, counts };
    });

    const total = emptyCounts();
    for (const item of districts) {
      for (const group of GROUPS) {
        total[group.key].plan += item.counts[group.key].plan;
        total[group.key].fact += item.counts[group.key].fact;
      }
    }

    const groups = GROUPS
      .map((group) => {
        const own = slices.filter((slice) => group.layers.includes(slice.key));
        const plan = total[group.key].plan;
        const fact = total[group.key].fact;
        return {
          key: group.key, title: group.title, commentTitle: group.commentTitle,
          plan, fact, percent: percent(fact, plan),
          objects: own.reduce((sum, slice) => sum + slice.counts.objects, 0),
          layers: own.map((slice) => ({
            key: slice.key, title: slice.layer.title, ...slice.counts
          }))
        };
      })
      .filter((group) => group.plan > 0);

    const overallOf = (item) => {
      const plan = GROUPS.reduce((sum, group) => sum + item.counts[group.key].plan, 0);
      const fact = GROUPS.reduce((sum, group) => sum + item.counts[group.key].fact, 0);
      return { plan, fact, percent: percent(fact, plan) };
    };
    const rows = districts.map((item) => ({ ...item, overall: overallOf(item) }));

    // Верхняя таблица — устойчивый справочник: районы по алфавиту, «АвД САО» в
    // конце. Нижняя уходит в штаб и сортируется по «Итого: %». Одинаковые
    // проценты разводим по числу подтверждённых точек, затем по названию —
    // порядок должен быть устойчивым, чтобы строки не «гуляли» между выгрузками.
    const sorted = [...rows].sort((left, right) =>
      right.overall.percent - left.overall.percent
      || right.overall.fact - left.overall.fact
      || left.name.localeCompare(right.name, 'ru'));

    return {
      generatedAt: new Date().toISOString(),
      slices,
      layers: slices.map((slice) => ({
        key: slice.key, title: slice.layer.title, idLabel: slice.layer.idLabel, ...slice.counts
      })),
      groups,
      districts: rows,
      total,
      overall: overallOf({ counts: total }),
      sorted,
      lagging: rows.filter((item) => item.overall.fact === 0).map((item) => item.name)
    };
  }

  /* ------------------------------------------------------------ дата и время */

  /** Дата и время выгрузки в московском времени: заказчик читает их в письме. */
  function moscowMoment(value) {
    return new Date(value ? value : Date.now()).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function moscowDate(value) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(value ? value : Date.now()));
  }

  function countText(value) {
    return Number(value || 0).toLocaleString('ru-RU');
  }

  /* ------------------------------------------------------- CSV по объектам ОДХ */

  /**
   * CSV-выгрузка по районам: UTF-8 с BOM, разделитель «;», строка «ИТОГО» в
   * конце. BOM и «;» нужны, чтобы русская версия Excel разложила строку по
   * столбцам, а числа остались целыми без разделителей разрядов.
   *
   * Срез только по ОДХ: отчёт называется «по маршрутам», и подмешивать в него
   * контейнеры, площадки СММ и гидранты нельзя — числа перестают читаться.
   * Имя файла отличается от `odh-routes-<дата>.csv`: под этим именем служба
   * отдаёт свой отчёт о приёмке маршрутов, и два разных файла не могут
   * называться одинаково.
   */
  function objectsCsv(model) {
    const header = ['Район', 'Объектов', 'Точек', 'I очередь', 'II очередь', 'III очередь', 'Площадь, м²'];
    const line = (values) => values.join(';');
    const queues = model.slices
      .filter((slice) => slice.layer.queue)
      .sort((left, right) => left.key.localeCompare(right.key));

    // Ни один район не выпадает из выгрузки, даже с нулём объектов: пустая
    // строка читается как «работы нет», а отсутствующая — как «район не учли».
    const rows = model.districts.map((item) => {
      const odh = queues.map((slice) => slice.rows.filter((row) => row.district === item.name).length);
      const objects = queues.reduce((sum, slice) => sum + objectCountOf(slice, item.name), 0);
      const area = queues.reduce((sum, slice) => sum + slice.rows
        .filter((row) => row.district === item.name)
        .reduce((inner, row) => inner + (Number(row.properties?.area_m2) || 0), 0), 0);
      return {
        name: item.name, objects, odh, area: Math.round(area),
        points: odh.reduce((sum, value) => sum + value, 0)
      };
    });

    rows.sort((left, right) => right.objects - left.objects || left.name.localeCompare(right.name, 'ru'));

    const totals = rows.reduce((acc, row) => ({
      objects: acc.objects + row.objects,
      points: acc.points + row.points,
      odh: acc.odh.map((value, index) => value + row.odh[index]),
      area: acc.area + row.area
    }), { objects: 0, points: 0, odh: [0, 0, 0], area: 0 });

    const lines = [line(header)];
    for (const row of rows) {
      lines.push(line([row.name, row.objects, row.points, ...row.odh, row.area]));
    }
    lines.push(line(['ИТОГО', totals.objects, totals.points, ...totals.odh, totals.area]));
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }

  /** Уникальные объекты по ID слоя среди точек одного района. */
  function objectCountOf(slice, district) {
    const ids = new Set();
    for (const row of slice.rows) {
      if (row.district !== district) continue;
      const id = row.properties?.[slice.layer.objectId];
      ids.add(id === null || id === undefined || id === '' ? `точка-${ids.size + 1}` : String(id));
    }
    return ids.size;
  }

  function objectsCsvName(model) {
    return `sao-odh-objekty-${moscowDate(model.generatedAt)}.csv`;
  }

  /* ------------------------------------------------------------------- Excel */

  /** Столбцы таблицы на штаб: № , район и по блоку «Объекты / Факт / %». */
  function headquartersColumns(model) {
    const columns = [
      { start: 1, end: 1, title: '№', fill: 'FFD9D9D9' },
      { start: 2, end: 2, title: 'Район', fill: 'FFD9D9D9' }
    ];
    const fills = ['FFC9DAF8', 'FFD9EAD3', 'FFF9CB9C', 'FFD9D9D9'];
    let cursor = 3;
    for (const group of model.groups) {
      columns.push({ start: cursor, end: cursor + 2, title: group.title, fill: fills[columns.length - 2] });
      cursor += 3;
    }
    columns.push({ start: cursor, end: cursor + 2, title: 'Итого', fill: 'FFD9D9D9' });
    return {
      columns,
      count: cursor + 2,
      blocks: model.groups.length + 1,
      percentColumns: columns.slice(2).map((column) => column.end)
    };
  }

  /** Плоский ряд значений строки: [план, факт, %] по блокам, затем «Итого». */
  function blockValues(item, model) {
    const values = [];
    for (const group of model.groups) {
      const cell = item.counts[group.key];
      values.push(cell.plan, cell.fact, percent(cell.fact, cell.plan));
    }
    values.push(item.overall.plan, item.overall.fact, item.overall.percent);
    return values;
  }

  function writeHeadquartersHeader(sheet, headerRow, columns) {
    for (const column of columns) {
      if (column.start === column.end) sheet.mergeCells(headerRow, column.start, headerRow + 1, column.start);
      else sheet.mergeCells(headerRow, column.start, headerRow, column.end);
      sheet.getCell(headerRow, column.start).value = column.title;
      for (let index = column.start; index <= column.end; index += 1) {
        for (const row of [headerRow, headerRow + 1]) {
          const cell = sheet.getCell(row, index);
          cell.fill = solidFill(column.fill);
          cell.border = CELL_BORDER;
          cell.alignment = CENTERED;
          cell.font = { name: HEADQUARTERS_FONT, bold: true, size: row === headerRow ? 11 : 9 };
        }
      }
      if (column.start === column.end) continue;
      ['Объекты', 'Факт', '%'].forEach((label, offset) => {
        sheet.getCell(headerRow + 1, column.start + offset).value = label;
      });
    }
  }

  function paintPercentCells(sheet, firstRow, lastRow, percentColumns) {
    for (const column of percentColumns) {
      const letter = sheet.getColumn(column).letter;
      const planLetter = sheet.getColumn(column - 2).letter;
      const cell = `$${letter}${firstRow}`;
      const plan = `$${planLetter}${firstRow}`;
      sheet.addConditionalFormatting({
        ref: `${letter}${firstRow}:${letter}${lastRow}`,
        rules: [
          { band: 'zero', when: `${cell}<=0` },
          { band: 'low', when: `AND(${cell}>0,${cell}<33)` },
          { band: 'middle', when: `AND(${cell}>=33,${cell}<66)` },
          { band: 'high', when: `${cell}>=66` }
        ].map(({ band, when }) => ({
          type: 'expression',
          // Без плана красить нечего: у строки пустой категории цвета нет.
          formulae: [`AND(${plan}>0,ISNUMBER(${cell}),${when})`],
          style: { fill: solidFill(BAND_FILLS[band]) }
        }))
      });
    }
  }

  /** Таблица районов: шапка, строки, «ИТОГО по САО» и светофор на проценты. */
  function writeHeadquartersTable(sheet, headerRow, model, rows, { formula = false } = {}) {
    const { columns, count, percentColumns } = headquartersColumns(model);
    const firstDataRow = headerRow + 2;
    const totalRow = firstDataRow + rows.length;
    writeHeadquartersHeader(sheet, headerRow, columns);

    rows.forEach((item, index) => {
      const values = [index + 1, item.name, ...blockValues(item, model)];
      values.forEach((value, offset) => {
        const column = offset + 1;
        const cell = sheet.getCell(firstDataRow + index, column);
        cell.value = value;
        cell.fill = solidFill(percentColumns.includes(column)
          ? percentBandFill(value, values[column - 3])
          : 'FFFFFFFF');
        cell.border = CELL_BORDER;
        cell.alignment = CENTERED;
        cell.font = { name: HEADQUARTERS_FONT, size: 11, bold: percentColumns.includes(column) };
        cell.numFmt = percentColumns.includes(column) ? '0"%"' : '0';
      });
    });

    const totalValues = blockValues({ counts: model.total, overall: model.overall }, model);
    sheet.mergeCells(totalRow, 1, totalRow, 2);
    sheet.getCell(totalRow, 1).value = 'ИТОГО по САО';
    for (let column = 3; column <= count; column += 1) {
      const cell = sheet.getCell(totalRow, column);
      const value = totalValues[column - 3];
      const percentColumn = percentColumns.includes(column);
      cell.value = value;
      cell.fill = solidFill(percentColumn
        ? percentBandFill(value, totalValues[column - 5])
        : 'FFFFFFFF');
      cell.border = CELL_BORDER;
      cell.alignment = CENTERED;
      cell.font = { name: HEADQUARTERS_FONT, size: 11, bold: true };
      cell.numFmt = percentColumn ? '0"%"' : '0';
    }

    // Живая сортировка: значения под формулой остаются на месте, поэтому файл
    // открывается и там, где динамических массивов нет.
    if (formula && rows.length) {
      const lastColumn = sheet.getColumn(count).letter;
      sheet.getCell(firstDataRow, 2).value = {
        shareType: 'array',
        formula: `SORT(B${firstDataRow}:${lastColumn}${totalRow - 1},${count},-1)`,
        ref: `B${firstDataRow}:${lastColumn}${totalRow - 1}`,
        result: rows[0].name
      };
    }

    // Светофор дублируем правилами: цвета остаются верными после правок данных.
    paintPercentCells(sheet, firstDataRow, totalRow, percentColumns);
    return totalRow;
  }

  function writeNote(sheet, row, count, text, options) {
    const settings = options || {};
    sheet.mergeCells(row, 1, row, count);
    const cell = sheet.getCell(row, 1);
    cell.value = text;
    cell.alignment = TO_LEFT;
    cell.font = {
      name: HEADQUARTERS_FONT,
      size: settings.size || 8,
      bold: Boolean(settings.bold),
      color: { argb: settings.ink || HEADQUARTERS_MUTED }
    };
    return row;
  }

  /**
   * Комментарий к выгрузке: сначала фиксированная строка «Направление — проект —
   * дата и время», затем разбор текущих чисел. Строки одинаковой формы нужны,
   * чтобы текст читался и в письме, и в картинке.
   */
  function headquartersComment(model, options) {
    const settings = options || {};
    const direction = settings.direction || model.direction || HEADQUARTERS_DIRECTION;
    const unit = settings.unit || 'точек';
    const leaders = model.sorted.filter((item) => item.overall.fact > 0).slice(0, 3);
    const categories = [...model.groups].sort((left, right) => left.percent - right.percent);
    const lines = [
      `Направление — «${direction}» — ${moscowMoment(settings.generatedAt || model.generatedAt)} (МСК)`,
      '',
      'Коллеги, добрый день!',
      `${direction}: ${countText(model.overall.fact)} из ${countText(model.overall.plan)} ${unit} — ${model.overall.percent} %.`
    ];

    if (model.lagging.length) {
      lines.push(settings.laggingText || 'Слабая динамика по подтверждению слоёв! Следующим районам срочно приступить к данной задаче:');
      lines.push(...model.lagging);
    } else {
      lines.push(settings.noneText || 'Подтверждённые данные есть по всем районам, отстающих нет.');
    }

    if (leaders.length) {
      const label = settings.leadersText || 'Больше всего подтверждено';
      lines.push(`${label}: ${leaders.map((item) => `${item.name} — ${item.overall.percent} %`).join(', ')}.`);
    }

    // Строка про приёмку нужна отчёту по маршрутам: в сетку эталона состояния не
    // помещаются, а штабу они нужны.
    for (const line of settings.extraLines || []) lines.push(line);

    if (categories.length) {
      lines.push(`По категориям: ${categories.map((group) => `${group.commentTitle} ${group.percent} %`).join(', ')}.`);
      lines.push(`Слабее всего — ${categories[0].commentTitle} (${categories[0].percent} %).`);
    }
    return lines;
  }

  /** Отметка времени в московском времени; пусто, если отправок не было. */
  function formatSubmittedAt(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '';
    return moscowMoment(date).replace(',', '');
  }

  /** Более поздняя из двух отметок времени; пусто, если их нет. */
  function laterOf(left, right) {
    const leftMs = left ? new Date(left).valueOf() : Number.NaN;
    const rightMs = right ? new Date(right).valueOf() : Number.NaN;
    if (Number.isNaN(leftMs)) return Number.isNaN(rightMs) ? null : new Date(rightMs).toISOString();
    if (Number.isNaN(rightMs)) return new Date(leftMs).toISOString();
    return new Date(Math.max(leftMs, rightMs)).toISOString();
  }

  /**
   * Разбор наборов районов: сколько объектов каждого типа район прислал и в каком
   * они состоянии. Считаются все объекты всех наборов — так же, как в сводке
   * службы, поэтому «Всего» сходится с суммой её маршрутов, зон и точек.
   */
  function collectBase(submissions) {
    const byDistrict = new Map();
    const blank = (name) => ({
      district: name, types: {}, kinds: kindsBlank(), total: 0,
      submitted: 0, approved: 0, rejected: 0, lastSubmittedAt: null
    });
    const ensure = (name) => {
      if (!byDistrict.has(name)) byDistrict.set(name, blank(name));
      return byDistrict.get(name);
    };

    for (const submission of Array.isArray(submissions) ? submissions : []) {
      const item = ensure(String((submission && submission.district) || '').trim() || AUTODOR_HOLDER);
      const changeSet = (submission && submission.change_set) || {};
      for (const feature of changeSet.features || []) {
        const key = (feature && feature.properties && feature.properties.change_type) || 'other';
        item.types[key] = (item.types[key] || 0) + 1;
        item.total += 1;
        const kind = groupOfType(key);
        item.kinds[kind].plan += 1;
        if (submission.status === 'submitted') item.submitted += 1;
        else if (submission.status === 'approved') {
          item.approved += 1;
          item.kinds[kind].fact += 1;
        } else if (submission.status === 'rejected') item.rejected += 1;
      }
      item.lastSubmittedAt = laterOf(item.lastSubmittedAt, submission && submission.submitted_at);
    }

    // Район без отправок тоже обязан попасть в отчёт: пропущенная строка читалась
    // бы как «район не учли», а не как «район ещё не начинал».
    const names = [...DISTRICT_NAMES];
    for (const name of byDistrict.keys()) {
      if (!names.includes(name)) names.push(name);
    }

    const totals = blank('ИТОГО');
    const districts = names
      .map((name) => byDistrict.get(name) || blank(name))
      .map((item) => {
        for (const [key, value] of Object.entries(item.types)) {
          totals.types[key] = (totals.types[key] || 0) + value;
        }
        for (const group of ROUTE_GROUPS) {
          totals.kinds[group.key].plan += item.kinds[group.key].plan;
          totals.kinds[group.key].fact += item.kinds[group.key].fact;
        }
        totals.total += item.total;
        totals.submitted += item.submitted;
        totals.approved += item.approved;
        totals.rejected += item.rejected;
        totals.lastSubmittedAt = laterOf(totals.lastSubmittedAt, item.lastSubmittedAt);
        const priority = PRIORITY_TYPES
          .reduce((sum, type) => sum + (item.types[type.key] || 0), 0);
        return { ...item, priority, other: item.total - priority };
      })
      // Строки читают сверху вниз: сначала те, кто больше прислал.
      .sort((left, right) => right.total - left.total || left.district.localeCompare(right.district, 'ru'));

    totals.priority = PRIORITY_TYPES.reduce((sum, type) => sum + (totals.types[type.key] || 0), 0);
    totals.other = totals.total - totals.priority;

    const otherBreakdown = Object.entries(totals.types)
      .filter(([key]) => !PRIORITY_TYPES.some((type) => type.key === key))
      .map(([key, count]) => ({ key, label: typeLabel(key), count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'ru'));

    // Тот же срез, но в форме листа «На штаб»: сверху устойчивый справочник
    // (районы по алфавиту, «АвД САО» последней строкой), снизу — по «Итого: %».
    const stable = names
      .map((name) => byDistrict.get(name) || blank(name))
      .sort((left, right) => (left.district === AUTODOR_HOLDER ? 1
        : right.district === AUTODOR_HOLDER ? -1
          : left.district.localeCompare(right.district, 'ru')))
      .map((item) => ({
        name: item.district,
        counts: ROUTE_GROUPS.reduce((acc, group) => ({ ...acc, [group.key]: item.kinds[group.key] }), {}),
        overall: overallOfKinds(item.kinds)
      }));

    const board = {
      generatedAt: new Date().toISOString(),
      direction: ROUTE_DIRECTION,
      note: ROUTE_NOTE,
      states: { submitted: totals.submitted, approved: totals.approved, rejected: totals.rejected },
      groups: ROUTE_GROUPS.map((group) => ({
        ...group,
        plan: totals.kinds[group.key].plan,
        fact: totals.kinds[group.key].fact,
        percent: percent(totals.kinds[group.key].fact, totals.kinds[group.key].plan)
      })),
      districts: stable,
      total: totals.kinds,
      overall: overallOfKinds(totals.kinds),
      // Порядок должен быть устойчивым, чтобы строки не «гуляли» между выгрузками.
      sorted: [...stable].sort((left, right) =>
        right.overall.percent - left.overall.percent
        || right.overall.fact - left.overall.fact
        || left.name.localeCompare(right.name, 'ru')),
      lagging: stable.filter((item) => item.overall.plan === 0).map((item) => item.name)
    };

    return {
      generatedAt: new Date().toISOString(),
      districts,
      totals,
      otherBreakdown,
      totalPriority: PRIORITY_TYPES
        .map((type) => ({ key: type.key, title: type.title, count: totals.types[type.key] || 0 })),
      lagging: districts.filter((item) => item.total === 0).map((item) => item.district),
      board
    };
  }

  /** «Итого» строки и всего округа: план, факт и процент по всем видам. */
  function overallOfKinds(kinds) {
    const plan = ROUTE_GROUPS.reduce((sum, group) => sum + kinds[group.key].plan, 0);
    const fact = ROUTE_GROUPS.reduce((sum, group) => sum + kinds[group.key].fact, 0);
    return { plan, fact, percent: percent(fact, plan) };
  }

  /** Ряд значений строки блока: приоритетные типы, прочие, всего и приёмка. */
  function baseRowValues(item) {
    return [
      ...PRIORITY_TYPES.map((type) => item.types[type.key] || 0),
      item.other, item.total, item.submitted, item.approved, item.rejected,
      formatSubmittedAt(item.lastSubmittedAt)
    ];
  }

  /** Строка про районы без объектов: одна формулировка на книгу и печатную форму. */
  function baseLaggingText(model) {
    const lagging = (model && model.lagging) || [];
    return lagging.length
      ? `Без объектов (${lagging.length}): ${lagging.join(', ')}.`
      : 'Объекты прислали все районы округа.';
  }

  /**
   * Примечание под блоком. Объясняет состав «Прочих объектов» и главное
   * расхождение: здесь приёмка считает все объекты набора, а в сводке службы —
   * только маршруты, поэтому числа в этих колонках больше.
   */
  function baseNote(model) {
    const others = model.otherBreakdown.length
      ? model.otherBreakdown.map((entry) => `${entry.label} — ${entry.count}`).join(', ')
      : 'такие объекты районы не присылали';
    return `«Всего» — все объекты, которые районы нарисовали и отправили; столько же в сумме показывают «Маршрутов», «Зон» и «Точек» в сводке службы. В «Прочие объекты» вошло: ${others}. Колонки приёмки считают все объекты набора, а в сводке службы «На приёмке», «Утверждено» и «Отклонено» считают только маршруты — поэтому здесь числа больше.`;
  }

  /** Короткая сводка для сайдбара карты: одна фраза, без таблицы. */
  function baseSummary(model) {
    if (!model) return '';
    const types = model.totalPriority
      .map((entry) => `${entry.title.toLowerCase()} ${countText(entry.count)}`)
      .join(', ');
    return [
      `объектов ${countText(model.totals.total)}: ${types}, прочие ${countText(model.totals.other)}`,
      `на приёмке ${countText(model.totals.submitted)}, утверждено ${countText(model.totals.approved)}, отклонено ${countText(model.totals.rejected)}`,
      model.lagging.length ? `без объектов: ${model.lagging.join(', ')}` : 'объекты прислали все районы'
    ].join(' · ');
  }

  /**
   * Блок «Объекты районов в единой базе» внутри сводки на штаб: сколько объектов
   * какого типа прислал район и что из присланного принято.
   */
  function writeBaseTable(sheet, startRow, model) {
    const columns = baseColumns();
    const count = columns.length;
    sheet.mergeCells(startRow, 1, startRow, count);
    const title = sheet.getCell(startRow, 1);
    title.value = BASE_TITLE;
    title.font = { name: HEADQUARTERS_FONT, size: 12, bold: true, color: { argb: HEADQUARTERS_INK } };
    title.alignment = TO_LEFT;
    sheet.getRow(startRow).height = 22;

    if (!model) {
      // Пустой блок не оставляем: без пометки читалось бы как «объектов нет».
      writeNote(sheet, startRow + 1, count, BASE_EMPTY, { size: 10 });
      return startRow + 3;
    }

    const headerRow = startRow + 1;
    columns.forEach((label, offset) => {
      const cell = sheet.getCell(headerRow, offset + 1);
      cell.value = label;
      cell.fill = solidFill('FFD9D9D9');
      cell.border = CELL_BORDER;
      cell.alignment = CENTERED;
      cell.font = { name: HEADQUARTERS_FONT, bold: true, size: 10 };
    });

    model.districts.forEach((item, index) => {
      [index + 1, item.district, ...baseRowValues(item)].forEach((value, offset) => {
        const column = offset + 1;
        const cell = sheet.getCell(headerRow + 1 + index, column);
        cell.value = value === null || value === undefined ? '' : value;
        cell.border = CELL_BORDER;
        cell.alignment = column === 2 ? TO_LEFT : CENTERED;
        cell.font = { name: HEADQUARTERS_FONT, size: 10 };
        if (column > 2 && column < count) cell.numFmt = '0';
      });
    });

    const totalRow = headerRow + 1 + model.districts.length;
    const totalValues = baseRowValues(model.totals);
    sheet.mergeCells(totalRow, 1, totalRow, 2);
    sheet.getCell(totalRow, 1).value = 'ИТОГО';
    totalValues.forEach((value, offset) => {
      const cell = sheet.getCell(totalRow, offset + 3);
      cell.value = value === null || value === undefined ? '' : value;
      if (offset < totalValues.length - 1) cell.numFmt = '0';
    });
    for (let column = 1; column <= count; column += 1) {
      const cell = sheet.getCell(totalRow, column);
      cell.border = CELL_BORDER;
      cell.fill = solidFill('FFEFEFEF');
      cell.alignment = column === 2 ? TO_LEFT : CENTERED;
      cell.font = { name: HEADQUARTERS_FONT, size: 10, bold: true };
    }

    const laggingRow = totalRow + 1;
    writeNote(sheet, laggingRow, count, baseLaggingText(model), { size: 10 });
    writeNote(sheet, laggingRow + 1, count, baseNote(model));
    return laggingRow + 3;
  }

  /** Лист «На штаб»: справочник районов сверху, таблица по проценту снизу. */
  function addHeadquartersSheet(workbook, model) {
    const sheet = workbook.addWorksheet('На штаб');
    const { count } = headquartersColumns(model);
    sheet.getColumn(1).width = 4.71;
    sheet.getColumn(2).width = 25.43;
    for (let column = 3; column <= count; column += 1) sheet.getColumn(column).width = 14.43;

    const firstTotalRow = writeHeadquartersTable(sheet, 1, model, model.districts);
    const secondTotalRow = writeHeadquartersTable(sheet, firstTotalRow + 4, model, model.sorted, { formula: true });

    // Колонка «Последняя отправка» в блоке единой базы шире остальных: в неё
    // должна влезть отметка «дд.мм.гггг чч:мм» целиком, без переноса.
    const lastBaseColumn = baseColumns().length;
    if (lastBaseColumn <= count) sheet.getColumn(lastBaseColumn).width = 21;

    // Объекты районов идут до комментария: их читают вместе с таблицей, а
    // комментарий и примечание закрывают лист.
    const afterBase = writeBaseTable(sheet, secondTotalRow + 3, model.base || null);

    const comment = headquartersComment(model);
    comment.forEach((line, offset) => writeNote(sheet, afterBase + offset, count, line, {
      size: offset === 0 ? 11 : 10,
      bold: offset === 0,
      ink: offset === 0 ? HEADQUARTERS_INK : 'FF000000'
    }));
    writeNote(sheet, afterBase + comment.length + 1, count, HEADQUARTERS_NOTE);
    return sheet;
  }

  /**
   * Лист «На штаб» для отчёта по маршрутам: та же форма, что у фотофиксации —
   * сверху справочник районов, снизу та же таблица по «Итого: %», ниже
   * комментарий и примечание. Числа берёт общая модель, поэтому лист, письмо и
   * печатная форма не расходятся.
   */
  function addRouteBoardSheet(workbook, board) {
    const sheet = workbook.addWorksheet('На штаб');
    const { count } = headquartersColumns(board);
    sheet.getColumn(1).width = 4.71;
    sheet.getColumn(2).width = 25.43;
    for (let column = 3; column <= count; column += 1) sheet.getColumn(column).width = 14.43;

    const firstTotalRow = writeHeadquartersTable(sheet, 1, board, board.districts);
    const secondTotalRow = writeHeadquartersTable(sheet, firstTotalRow + 4, board, board.sorted, { formula: true });

    const states = board.states || { submitted: 0, approved: 0, rejected: 0 };
    const comment = headquartersComment(board, {
      unit: 'объектов',
      laggingText: 'Слабая динамика по отрисовке маршрутов! Следующим районам срочно приступить к данной задаче:',
      noneText: 'Объекты прислали все районы округа, отстающих нет.',
      leadersText: 'Больше всего нарисовали',
      // Состояния приёмки в сетку эталона не помещаются, а штабу они нужны.
      extraLines: [
        `Приёмка: на приёмке ${countText(states.submitted)}, утверждено ${countText(states.approved)}, `
        + `отклонено ${countText(states.rejected)} — считаются все объекты наборов.`
      ]
    });
    comment.forEach((line, offset) => writeNote(sheet, secondTotalRow + 2 + offset, count, line, {
      size: offset === 0 ? 11 : 10,
      bold: offset === 0,
      ink: offset === 0 ? HEADQUARTERS_INK : 'FF000000'
    }));
    writeNote(sheet, secondTotalRow + comment.length + 3, count, board.note || ROUTE_NOTE);
    return sheet;
  }

  /** Книга «маршруты на штаб»: один лист, та же форма, что у фотофиксации. */
  function buildRoutesHeadquarters(base, ExcelJS) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Карта ОДХ САО';
    workbook.created = new Date();
    addRouteBoardSheet(workbook, base.board);
    return workbook;
  }

  /** Лист «Обзор»: что лежит на карте и на чём основаны числа. */
  function addOverviewSheet(workbook, model) {
    const sheet = workbook.addWorksheet('Обзор');
    [44, 12, 18, 15, 40, 52].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    const header = sheet.addRow([
      'Показатель', 'Точек', 'Объектов по ID', 'Подтверждено',
      'Что считает вторая единица', 'Источник'
    ]);
    header.font = { name: HEADQUARTERS_FONT, bold: true, color: { argb: HEADQUARTERS_INK } };

    for (const layer of model.layers) {
      const slice = model.slices.find((item) => item.key === layer.key);
      const source = [...new Set(slice.rows.map((row) => row.source).filter(Boolean))][0] || '—';
      sheet.addRow([layer.title, layer.plan, layer.objects, layer.fact, layer.idLabel, source]);
    }
    const totalRow = sheet.addRow([
      'ИТОГО по САО', model.overall.plan,
      model.layers.reduce((sum, layer) => sum + layer.objects, 0),
      model.overall.fact, '', ''
    ]);
    totalRow.font = { name: HEADQUARTERS_FONT, bold: true };
    sheet.addRow([]);
    writeNote(sheet, sheet.rowCount, 6, HEADQUARTERS_NOTE);
    return sheet;
  }

  /** Лист «Районы»: обе единицы счёта рядом — точки и объекты по ID. */
  function addDistrictsSheet(workbook, model) {
    const sheet = workbook.addWorksheet('Районы');
    [6, 26, 34, 12, 16, 16, 10].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    const header = sheet.addRow(['№', 'Район', 'Категория', 'Точек', 'Объектов по ID', 'Подтверждено', '%']);
    header.font = { name: HEADQUARTERS_FONT, bold: true, color: { argb: HEADQUARTERS_INK } };
    header.alignment = CENTERED;

    model.districts.forEach((item, index) => {
      for (const group of model.groups) {
        const own = model.slices.filter((slice) => group.layers.includes(slice.key));
        const points = item.counts[group.key].plan;
        const confirmed = item.counts[group.key].fact;
        const objects = own.reduce((sum, slice) => sum + objectCountOf(slice, item.name), 0);
        const value = percent(confirmed, points);
        const row = sheet.addRow([index + 1, item.name, group.title, points, objects, confirmed, value]);
        row.getCell(7).numFmt = '0"%"';
        row.getCell(7).fill = solidFill(percentBandFill(value, points));
        row.getCell(7).font = { name: HEADQUARTERS_FONT, bold: true };
      }
    });
    writeNote(sheet, sheet.rowCount + 2, 7, HEADQUARTERS_NOTE);
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return sheet;
  }

  /** Лист слоя: полные атрибуты источника без сокращений. */
  function addLayerSheet(workbook, slice) {
    const sheet = workbook.addWorksheet(slice.layer.sheet);
    const source = [...new Set(slice.rows.flatMap((row) => Object.keys(row.properties)))]
      .filter((key) => !SOURCE_COLUMNS.includes(key));
    const headers = [...SOURCE_COLUMNS, ...source];
    const header = sheet.addRow(headers);
    header.font = { name: HEADQUARTERS_FONT, bold: true, color: { argb: HEADQUARTERS_INK } };
    header.alignment = CENTERED;
    header.eachCell((cell) => { cell.fill = solidFill('FFD9D9D9'); cell.border = CELL_BORDER; });

    for (const row of slice.rows) {
      const values = [row.district, row.confirmed, row.source, ...source.map((key) => row.properties[key])];
      sheet.addRow(values.map((value) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return JSON.stringify(value);
        return value;
      })).alignment = TO_LEFT;
    }

    [22, 14, 44].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    for (let column = SOURCE_COLUMNS.length + 1; column <= headers.length; column += 1) {
      sheet.getColumn(column).width = 24;
    }
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: headers.length } };
    return sheet;
  }

  /** Книга выгрузки: 'register' — полный реестр, 'headquarters' — только штаб. */
  function buildWorkbook(model, ExcelJS, kind) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Карта ОДХ САО';
    workbook.created = new Date(model.generatedAt);
    if (kind === 'headquarters') {
      addHeadquartersSheet(workbook, model);
      return workbook;
    }
    addOverviewSheet(workbook, model);
    addHeadquartersSheet(workbook, model);
    addDistrictsSheet(workbook, model);
    for (const slice of model.slices) {
      if (!slice.layer.hidden) addLayerSheet(workbook, slice);
    }
    return workbook;
  }

  /* --------------------------------------------------------- браузер и файлы */

  function downloadBlob(blob, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  function downloadText(text, filename) {
    downloadBlob(new Blob([text], { type: 'text/csv; charset=utf-8' }), filename);
  }

  /** Печатная форма таблицы на штаб: тот же состав, что в Excel, для PDF. */
  function headquartersHtml(model) {
    const escapeHtml = (value) => String(value === null || value === undefined ? '' : value)
      .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const bandColor = (value, plan) => {
      const argb = percentBandFill(value, plan);
      return argb === 'FFFFFFFF' ? '#ffffff' : `#${argb.slice(2).toLowerCase()}`;
    };
    const fills = ['#c9daf8', '#d9ead3', '#f9cb9c', '#d9d9d9'];
    const groupHead = model.groups
      .map((group, index) => `<th colspan="3" style="background:${fills[index % fills.length]}">${escapeHtml(group.title)}</th>`)
      .join('') + '<th colspan="3">Итого</th>';
    const subHead = model.groups.map(() => '<th>Объекты</th><th>Факт</th><th>%</th>').join('')
      + '<th>Объекты</th><th>Факт</th><th>%</th>';

    // Плоский ряд [план, факт, %] превращается в ячейки блоков: процент красится
    // светофором по своему плану, который стоит на две колонки левее.
    const cellsHtml = (values) => values.reduce((acc, value, offset) => {
      if (offset % 3 !== 2) return `${acc}<td>${value}</td>`;
      return `${acc}<td class="pct" style="background:${bandColor(value, values[offset - 2])}">${value}%</td>`;
    }, '');

    const rowHtml = (item, index) => `<tr><td class="num">${index + 1}</td><td class="name">${escapeHtml(item.name)}</td>${cellsHtml(blockValues(item, model))}</tr>`;
    const totalRow = `<tr class="total"><td colspan="2">ИТОГО по САО</td>${cellsHtml(blockValues({ counts: model.total, overall: model.overall }, model))}</tr>`;
    const table = (rows) => `<table><thead>
  <tr><th rowspan="2" class="num">№</th><th rowspan="2" class="name">Район</th>${groupHead}</tr>
  <tr>${subHead}</tr>
</thead><tbody>${rows.map(rowHtml).join('')}${totalRow}</tbody></table>`;

    // Блок единой базы — тот же, что на листе «На штаб»: это срез сервиса, а не
    // слоёв карты, поэтому у него своя таблица под основной.
    const base = model.base || null;
    const baseHead = baseColumns().map((label) => `<th>${escapeHtml(label)}</th>`).join('');
    const baseCells = (values) => values.map((value) => `<td>${escapeHtml(value)}</td>`).join('');
    const baseBody = base
      ? base.districts.map((item, index) =>
        `<tr><td class="num">${index + 1}</td><td class="name">${escapeHtml(item.district)}</td>${baseCells(baseRowValues(item))}</tr>`).join('')
        + `<tr class="total"><td colspan="2">ИТОГО</td>${baseCells(baseRowValues(base.totals))}</tr>`
      : `<tr><td colspan="${baseColumns().length}">${escapeHtml(BASE_EMPTY)}</td></tr>`;
    const baseNotes = base
      ? `<p class="note">${escapeHtml(baseLaggingText(base))}</p><p class="note">${escapeHtml(baseNote(base))}</p>`
      : '';
    const baseBlock = `<section><h2>${escapeHtml(BASE_TITLE)}</h2>
<table><thead><tr>${baseHead}</tr></thead><tbody>${baseBody}</tbody></table>${baseNotes}</section>`;

    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>На штаб — ${escapeHtml(HEADQUARTERS_DIRECTION)}</title>
<style>
  body { font: 12px/1.45 "Century Gothic", Arial, sans-serif; color: #1f3b57; margin: 16px; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 20px 0 6px; }
  p.meta { color: #708089; margin: 0 0 14px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #000; padding: 3px 5px; text-align: center; font-size: 11px; }
  td.name, th.name { text-align: left; white-space: nowrap; }
  td.num { width: 26px; }
  .pct { font-weight: 700; }
  tr.total td { font-weight: 700; }
  pre { font: 11px/1.5 "Century Gothic", Arial, sans-serif; white-space: pre-wrap; margin: 0; }
  p.note { font-size: 9px; color: #708089; margin-top: 14px; }
  @media print { body { margin: 8mm; } h2 + table, section { break-inside: avoid; } }
</style></head><body>
<h1>${escapeHtml(HEADQUARTERS_DIRECTION)}</h1>
<p class="meta">${escapeHtml(moscowMoment(model.generatedAt))} (МСК) · карта — опубликованные слои ОДХ${base ? ' · объекты районов — единая база (сервис ОДХ)' : ''}</p>
${table(model.districts)}
<section><h2>То же по проценту «Итого» — в штаб</h2>${table(model.sorted)}</section>
${baseBlock}
<section><h2>Комментарий к выгрузке</h2><pre>${escapeHtml(headquartersComment(model).join('\n'))}</pre></section>
<p class="note">${escapeHtml(HEADQUARTERS_NOTE)}</p>
</body></html>`;
  }

  /** Открывает печатную форму: в ней же браузер сохраняет PDF. */
  function printHeadquarters(model) {
    const win = window.open('', '_blank');
    if (!win) return false;
    win.document.write(headquartersHtml(model));
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
    return true;
  }

  window.ODHExports = {
    AUTODOR_HOLDER, DISTRICT_NAMES, LAYERS, GROUPS,
    HEADQUARTERS_NOTE, HEADQUARTERS_DIRECTION,
    BASE_TITLE, BASE_EMPTY, PRIORITY_TYPES,
    districtOf, countOf, sliceLayer, collect, percent, percentBandFill,
    objectsCsv, objectsCsvName, objectCountOf, moscowMoment, moscowDate, formatSubmittedAt,
    headquartersColumns, blockValues, headquartersComment,
    baseColumns, typeLabel, groupOfType, collectBase, baseRowValues, baseLaggingText, baseNote, baseSummary,
    ROUTE_GROUPS, ROUTE_DIRECTION, ROUTE_NOTE, addRouteBoardSheet, buildRoutesHeadquarters,
    buildWorkbook, headquartersHtml, downloadBlob, downloadText, printHeadquarters
  };
}());
