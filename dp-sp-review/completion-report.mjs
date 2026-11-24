const groups = { all: 'ДП и СП', dp: 'Детские площадки', sp: 'Спортивные площадки' };
const states = ['accepted', 'submitted', 'rework', 'work'];
const headings = ['Район', 'Всего', 'Закрыто', 'На приёмке', 'На доработке', 'В работе', '% закрыто'];
const totals = () => ({ accepted: 0, submitted: 0, rework: 0, work: 0 });
const byKind = () => ({ all: totals(), dp: totals(), sp: totals() });
const integer = new Intl.NumberFormat('ru-RU');
const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 2 });
const moscowDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
const moscowDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });

function buildReport({ sites, generated_at }, districts) {
  const districtKey = name => name.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  const rows = new Map();
  const total = byKind();
  for (const name of districts) rows.set(districtKey(name), { name, counts: byKind() });
  for (const site of sites) {
    const name = site.district?.trim() || 'Без района';
    const key = districtKey(name);
    if (!rows.has(key)) rows.set(key, { name, counts: byKind() });
    if (!['dp', 'sp'].includes(site.kind) || !states.includes(site.state)) {
      throw Error('В реестре есть площадка с неизвестным видом или статусом.');
    }
    const { counts } = rows.get(key);
    for (const group of ['all', site.kind]) {
      counts[group][site.state]++;
      total[group][site.state]++;
    }
  }

  const ordered = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'));
  ordered.unshift({ name: 'Итого по САО', counts: total });
  const sheets = Object.entries(groups).map(([key, name]) => ({
    key, name,
    rows: ordered.map(({ name: label, counts }) => {
      const { accepted, submitted, rework, work } = counts[key];
      const all = accepted + submitted + rework + work;
      return [label, all, accepted, submitted, rework, work, all ? accepted / all : null];
    }),
  }));
  const instant = new Date(generated_at);
  return { headings, sheets, asOf: `Данные на ${moscowDate.format(instant)} (МСК)`, day: moscowDay.format(instant) };
}

export function initCompletionReport({ dialog, getDistricts, getSnapshot }) {
  const status = dialog.querySelector('#completionStatus');
  const content = dialog.querySelector('#completionContent');
  const kind = dialog.querySelector('#completionKind');
  const download = dialog.querySelector('#downloadCompletionReport');
  const retry = dialog.querySelector('#retryCompletionReport');
  const table = dialog.querySelector('#completionTable');
  let request, report;

  function cells(values, header = false) {
    const row = document.createElement('tr');
    values.forEach((value, index) => {
      const cell = document.createElement(header || index === 0 ? 'th' : 'td');
      if (cell.tagName === 'TH') cell.scope = header ? 'col' : 'row';
      cell.textContent = value;
      row.append(cell);
    });
    return row;
  }

  function render() {
    const sheet = report.sheets.find(sheet => sheet.key === kind.value);
    table.tBodies[0].replaceChildren(...sheet.rows.map(([name, ...counts]) => cells([
      name, ...counts.slice(0, 5).map(value => integer.format(value)),
      counts[5] == null ? '—' : percent.format(counts[5]),
    ])));
  }

  async function load() {
    request?.abort();
    const controller = request = new AbortController();
    report = null;
    retry.hidden = true;
    content.hidden = true;
    status.textContent = 'Загружаем сводку…';
    try {
      const snapshot = await getSnapshot(controller.signal);
      if (!dialog.open || request !== controller) return;
      report = buildReport(snapshot, getDistricts());
      status.textContent = report.asOf;
      content.hidden = false;
      render();
    } catch (error) {
      if (!dialog.open || request !== controller || controller.signal.aborted) return;
      status.textContent = `Не удалось загрузить сводку. ${error.message}`;
      retry.hidden = false;
    }
  }

  table.tHead.append(cells(headings, true));
  kind.addEventListener('change', render);
  retry.addEventListener('click', load);
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    request?.abort();
    report = null;
    table.tBodies[0].replaceChildren();
  });
  download.addEventListener('click', async () => {
    const snapshot = report;
    download.disabled = true;
    try {
      const { completionWorkbook } = await import('./completion-xlsx.mjs?v=20261124');
      if (!dialog.open || !snapshot || report !== snapshot) return;
      const url = URL.createObjectURL(completionWorkbook(snapshot));
      const link = document.createElement('a');
      link.href = url;
      link.download = `Сводка_оцифровки_ДП_СП_САО_${snapshot.day}.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = snapshot.asOf;
    } catch (error) {
      if (dialog.open && report === snapshot) status.textContent = `Не удалось выгрузить Excel. ${error.message}`;
    } finally {
      download.disabled = false;
    }
  });

  return () => {
    if (dialog.open) return;
    kind.value = 'all';
    dialog.showModal();
    load();
  };
}
