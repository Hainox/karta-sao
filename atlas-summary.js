/* Сводка префектуры: плашка поверх карты с ходом оцифровок (сколько фото принято,
   ждёт проверки, возвращено на доработку и ещё не снято). Видна только префектуре,
   обновляется раз в минуту, пока вкладка открыта. Оформление — .hud-summary в atlas-hud.css.

   const summary = createPrefectureSummary({
     title: 'Сводка района',
     sources: [{ label: 'Въездные группы', load: async () => ['accepted', 'empty', …] }],
   });
   summary.setVisible(true);
*/
(() => {
  // Состояния по умолчанию; первое — «готово» (его доля в процентах), последнее — «не начато».
  const DEFAULT_STATES = [
    ['accepted', 'принято', 'var(--hud-ok)'],
    ['pending', 'на проверке', 'var(--hud-pending)'],
    ['rework', 'на доработке', 'var(--hud-rework)'],
    ['empty', 'нет фото', 'var(--hud-empty)'],
  ];
  const ICON_REFRESH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
  const ICON_CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
  const num = (n) => Number(n).toLocaleString('ru-RU');

  function count(values, STATES) {
    const keys = STATES.map(([key]) => key);
    const counts = Object.fromEntries([['total', 0], ...keys.map((key) => [key, 0])]);
    for (const raw of values) {
      counts[keys.includes(raw) ? raw : keys[keys.length - 1]] += 1;
      counts.total += 1;
    }
    return counts;
  }

  /** Причина ошибки простыми словами: сеть, истёкший вход или ответ сервера. */
  function errorText(error) {
    const message = String(error && error.message || '');
    if (!message || /fetch|network|load failed/i.test(message)) return 'нет связи с сервером';
    if (/войдите/i.test(message)) return 'вход истёк — войдите снова';
    return message.replace(/[<>&"]/g, '').slice(0, 120);
  }

  function rowHtml(source, result, STATES) {
    if (result.error) {
      return `<li class="hud-sum-row"><div class="line"><span class="name">${source.label}</span><span class="pct">—</span></div>
        <div class="legend"><span style="--dot:var(--hud-rework)">${errorText(result.error)}</span></div></li>`;
    }
    const c = result.counts;
    const share = (n) => (c.total ? (n / c.total) * 100 : 0);
    const done = STATES[0][0];
    const pct = c.total ? Math.round(share(c[done])) : 0;
    const bar = STATES.slice(0, -1).map(([key, , color]) => `<i style="width:${share(c[key]).toFixed(2)}%;background:${color}"></i>`).join('');
    const legend = STATES.map(([key, label, color]) => `<span style="--dot:${color}">${label} ${num(c[key])}</span>`).join('');
    const title = `${source.label}: ${STATES[0][1]} ${num(c[done])} из ${num(c.total)}`;
    return `<li class="hud-sum-row" title="${title}"><div class="line"><span class="name">${source.label}</span>
      <span class="pct">${c.total ? pct + '%' : 'нет точек'}</span></div>
      <div class="hud-bar" role="img" aria-label="${title}">${bar}</div><div class="legend">${legend}</div></li>`;
  }

  function createPrefectureSummary({ title = 'Сводка', sources = [], states = DEFAULT_STATES, interval = 60000, storeKey = 'atlas-summary', parent = null } = {}) {
    const box = document.createElement('section');
    box.className = 'hud-summary';
    box.hidden = true;
    box.setAttribute('aria-label', title);
    box.innerHTML = `<header><b>${title}</b><small data-time aria-live="polite"></small>
      <button type="button" class="hud-icon-btn" data-refresh title="Обновить сейчас" aria-label="Обновить сводку">${ICON_REFRESH}</button>
      <button type="button" class="hud-icon-btn" data-collapse title="Свернуть" aria-label="Свернуть сводку" aria-expanded="true">${ICON_CHEVRON}</button></header>
      <ul data-rows></ul><p class="hud-sum-note">Обновляется само раз в минуту. Видно только префектуре.</p>`;
    // parent — блок карты, если карта не во весь экран: плашка встаёт в его угол.
    if (parent) box.classList.add('inside');
    (parent || document.body).appendChild(box);
    const rows = box.querySelector('[data-rows]');
    const time = box.querySelector('[data-time]');
    const collapseButton = box.querySelector('[data-collapse]');
    let visible = false;
    let timer = 0;
    let loading = false;
    let lastLoad = 0;

    const setCollapsed = (on, persist = true) => {
      box.classList.toggle('collapsed', on);
      collapseButton.setAttribute('aria-expanded', String(!on));
      collapseButton.title = on ? 'Развернуть' : 'Свернуть';
      box.querySelector('.hud-sum-note').hidden = on;
      if (persist) window.AtlasHud?.store.set(storeKey + ':collapsed', on ? '1' : '0');
    };
    // На телефоне плашка по умолчанию свёрнута, чтобы не закрывать карту.
    const saved = window.AtlasHud?.store.get(storeKey + ':collapsed');
    setCollapsed(saved == null ? window.matchMedia('(max-width: 820px)').matches : saved === '1', false);
    collapseButton.addEventListener('click', () => setCollapsed(!box.classList.contains('collapsed')));
    box.querySelector('[data-refresh]').addEventListener('click', () => refresh());

    async function refresh() {
      if (!visible || loading) return;
      loading = true;
      box.classList.add('busy');
      const results = await Promise.all(sources.map(async (source) => {
        try { return { counts: count(await source.load(), states) }; } catch (error) { return { error }; }
      }));
      loading = false;
      lastLoad = Date.now();
      box.classList.remove('busy');
      if (!visible) return;
      rows.innerHTML = sources.map((source, i) => rowHtml(source, results[i], states)).join('');
      time.textContent = 'обновлено ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }

    function schedule() {
      clearInterval(timer);
      timer = visible ? setInterval(() => { if (!document.hidden) refresh(); }, interval) : 0;
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && visible && Date.now() - lastLoad > interval) refresh();
    });

    return {
      element: box,
      refresh,
      setVisible(on) {
        on = Boolean(on);
        if (on === visible) return;
        visible = on;
        box.hidden = !on;
        if (!on) rows.innerHTML = '';
        schedule();
        if (on) refresh();
      },
    };
  }

  window.createPrefectureSummary = createPrefectureSummary;
})();
