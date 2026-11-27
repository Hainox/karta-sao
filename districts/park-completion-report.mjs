const labels = { accepted: 'Принято', pending: 'На проверке', rework: 'На доработке', empty: 'Без фото' };
const statuses = Object.keys(labels);
const pointHeadings = ['Точек всего', ...Object.values(labels), '% принято'];
const districtHeadings = ['Район', 'Парков всего', 'Парков без точек', ...pointHeadings];
const parkHeadings = ['Район', 'Парк', 'ID АСУ ОДС', ...pointHeadings];
const counts = () => ({ total: 0, accepted: 0, pending: 0, rework: 0, empty: 0 });
const totals = () => ({ ...counts(), parks: 0, withoutPoints: 0 });
const integer = new Intl.NumberFormat('ru-RU');
const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 2 });
const moscowDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
const moscowDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
const searchKey = value => value.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').trim();
const byName = (a, b) => a.localeCompare(b, 'ru-RU', { numeric: true });
const values = row => [row.total, ...statuses.map(status => row[status]), row.total ? row.accepted / row.total : null];
const registry = park => park.asu_ids.join(', ') || (park.registry_status === 'absent_in_source' ? 'Нет в АСУ ОДС' : 'Не подтверждён');
const dateText = value => value ? moscowDate.format(new Date(value)) : null;

function addPark(group, park) {
  group.parks++;
  if (park.total === 0) group.withoutPoints++;
  group.total += park.total;
  for (const status of statuses) group[status] += park[status];
}

export function buildParkCompletionReport(snapshot, { district = '', parkId = '', query = '', districts = [], mapLink },
  now = new Date()) {
  const needle = searchKey(query);
  const parks = new Map(snapshot.parks
    .filter(park => (!district || park.district === district) && (!parkId || park.id === parkId)
      && searchKey([park.name, park.district, ...park.asu_ids].join(' ')).includes(needle))
    .map(park => [park.id, { ...park, ...counts() }]));
  const points = [];
  const rework = [];
  for (const status of statuses) {
    for (const point of snapshot[status]) {
      const park = parks.get(point.park_id);
      if (!park) continue;
      park.total++;
      park[status]++;
      const prefix = [park.district, park.name, point.source_point_id];
      const href = mapLink(point);
      const link = { text: 'Открыть точку', hyperlink: href };
      points.push([...prefix, labels[status], point.latitude, point.longitude, point.heading, link]);
      if (status === 'rework') rework.push([...prefix, point.rejected_comment || 'Причина не указана', dateText(point.rejected_at), link]);
    }
  }

  const full = !district && !parkId && !needle;
  const byDistrict = new Map((full ? districts : district ? [district] : []).map(name => [name, totals()]));
  const all = totals();
  for (const park of parks.values()) {
    if (!byDistrict.has(park.district)) byDistrict.set(park.district, totals());
    addPark(byDistrict.get(park.district), park);
    addPark(all, park);
  }
  const scope = parkId ? snapshot.parks.find(park => park.id === parkId)?.name || 'Выбранный парк' : district || 'Весь САО';
  const scopeLabel = [scope, district && scope !== district ? district : '', query.trim() ? 'Поиск «' + query.trim() + '»' : '']
    .filter(Boolean).join(' · ');
  const rank = (a, b) => (b.total ? b.accepted / b.total : -1) - (a.total ? a.accepted / a.total : -1);
  const districtRows = [...byDistrict].sort(([nameA, a], [nameB, b]) => rank(a, b) || byName(nameA, nameB));
  const parkRows = [...parks.values()].sort((a, b) => byName(a.district, b.district) || rank(a, b) || byName(a.name, b.name));
  points.sort((a, b) => byName(a[0], b[0]) || byName(a[1], b[1]) || byName(a[2], b[2]));
  rework.sort((a, b) => byName(a[0], b[0]) || byName(a[1], b[1]) || byName(a[2], b[2]));
  const totalTitle = full ? 'Итого по САО' : 'Итого по выборке';
  const asOf = 'Данные на ' + dateText(now) + ' МСК · ' + scopeLabel;
  const sheets = [
    { name: 'Свод по районам', headings: districtHeadings, percentColumn: 8, widths: [28, 12, 14, 12, 12, 14, 14, 12, 14],
      rows: [[totalTitle, all.parks, all.withoutPoints, ...values(all)],
        ...districtRows.map(([name, row]) => [name, row.parks, row.withoutPoints, ...values(row)])] },
    { name: 'Свод по паркам', headings: parkHeadings, percentColumn: 8, widths: [24, 44, 22, 12, 12, 14, 14, 12, 14],
      rows: [[totalTitle, null, null, ...values(all)],
        ...parkRows.map(park => [park.district, park.name, registry(park), ...values(park)])] },
    { name: 'Точки', headings: ['Район', 'Парк', 'ID точки', 'Статус', 'Широта', 'Долгота', 'Азимут, °', 'На карте'],
      percentColumn: -1, total: false, filter: true, rowHeight: 28, widths: [25, 40, 39, 18, 15, 15, 12, 18], rows: points },
    { name: 'На доработке', headings: ['Район', 'Парк', 'ID точки', 'Что исправить', 'Возвращено, МСК', 'На карте'],
      percentColumn: -1, total: false, filter: true, rowHeight: 44, widths: [25, 40, 39, 60, 23, 18], rows: rework },
  ];
  return { sheets, asOf, day: moscowDay.format(now) };
}

export function initParkCompletionReport({ dialog, getSnapshot, getFilters, mapLink }) {
  const find = id => dialog.querySelector('#' + id);
  const status = find('parkReportStatus');
  const content = find('parkReportContent');
  const retry = find('parkReportRetry');
  const view = find('parkReportView');
  const download = find('parkReportDownload');
  const table = find('parkReportTable');
  let request, report, filters;

  function render() {
    const sheet = report.sheets[Number(view.value)];
    const headings = table.createTHead();
    headings.replaceChildren();
    const head = headings.insertRow();
    for (const heading of sheet.headings) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = heading;
      head.append(th);
    }
    const body = table.tBodies[0];
    body.replaceChildren();
    for (const values of sheet.rows) {
      const row = body.insertRow();
      values.forEach((value, index) => {
        row.insertCell().textContent = value == null ? '—' : index === sheet.percentColumn
          ? percent.format(value) : typeof value === 'number' ? integer.format(value) : value;
      });
    }
    find('parkReportScroll').scrollLeft = 0;
  }

  async function load() {
    request?.abort();
    const controller = request = new AbortController();
    report = null;
    content.hidden = retry.hidden = true;
    status.textContent = 'Загружаем сводку…';
    try {
      const snapshot = await getSnapshot(controller.signal);
      if (request !== controller || !dialog.open) return;
      report = buildParkCompletionReport(snapshot, { ...filters, mapLink });
      status.textContent = report.asOf;
      content.hidden = false;
      render();
    } catch (error) {
      if (request !== controller || !dialog.open || controller.signal.aborted) return;
      status.textContent = 'Не удалось загрузить сводку. ' + error.message;
      retry.hidden = false;
    }
  }

  view.onchange = render;
  retry.onclick = load;
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    request?.abort();
    report = null;
    table.tBodies[0].replaceChildren();
  });
  download.onclick = async () => {
    const current = report;
    download.disabled = true;
    try {
      const { completionWorkbook } = await import('../dp-sp-review/completion-xlsx.mjs?v=20261127');
      if (!dialog.open || report !== current || !current) return;
      const url = URL.createObjectURL(completionWorkbook(current));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'Сводка_оцифровки_парков_САО_' + current.day + '.xlsx';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (dialog.open && report === current) status.textContent = 'Не удалось выгрузить Excel. ' + error.message;
    } finally { download.disabled = false; }
  };

  return () => {
    if (dialog.open) return;
    filters = getFilters();
    view.value = filters.parkId ? '1' : '0';
    dialog.showModal();
    void load();
  };
}
