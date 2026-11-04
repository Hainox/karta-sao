// Выпадающий список частых причин возврата на доработку — общий для всех
// кабинетов приёмки. Причины приходят с сервера (/review/reasons: что чаще всего
// писали при возвратах во всех приёмках), без сервера — типовые причины.
//
//   ReviewReasons.attach(textarea, { load: () => fetchReasons() });
(function () {
  'use strict';
  const DEFAULTS = [
    'Фото размытое или нечёткое — переснимите',
    'Объект не попал в кадр целиком',
    'Снято не с той точки или не в ту сторону — снимите по стрелке точки',
    'Не тот объект или адрес',
    'Слишком темно или засвечено',
    'Объект закрыт машинами, людьми или деревьями',
    'Снято слишком близко — нужен общий план',
    'Не видно адресной таблички или номера дома',
    'Фото сделано не на месте — геометка далеко от объекта',
    'Старое или повторное фото — нужен новый снимок',
    'Кадр завален или перевёрнут',
    'На фото не устранены нарушения (мусор, снег, повреждения)',
  ].map((text) => ({ text, count: 0 }));

  let cached = null;
  function reasons(load) {
    if (!cached) {
      cached = Promise.resolve().then(load).then((list) => (Array.isArray(list) && list.length ? list : DEFAULTS))
        .catch(() => { cached = null; return DEFAULTS; });
    }
    return cached;
  }
  const times = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'раз' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'раза' : 'раз');

  /** Ставит список над полем комментария. Выбор дописывает причину в поле, текст можно поправить. */
  function attach(textarea, { load } = {}) {
    if (!textarea || textarea.previousElementSibling?.classList.contains('review-reason-picker')) return;
    const select = document.createElement('select');
    select.className = 'review-reason-picker';
    select.setAttribute('aria-label', 'Частые причины возврата');
    select.style.cssText = 'display:block;width:100%;margin:0 0 6px;padding:8px 9px;border:1px solid #cbd8cf;border-radius:8px;background:#fff;color:inherit;font:inherit;font-size:13px';
    const head = new Option('Частые причины — выберите, текст можно дополнить…', '');
    select.append(head);
    textarea.before(select);
    reasons(load).then((list) => {
      for (const { text, count } of list) {
        select.append(new Option(count ? `${text} · ${count} ${times(count)}` : text, text));
      }
    });
    select.addEventListener('change', () => {
      const text = select.value;
      select.value = '';
      if (!text) return;
      const current = textarea.value.trim();
      if (!current.toLowerCase().includes(text.toLowerCase())) textarea.value = current ? `${current}; ${text}` : text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
    });
  }

  window.ReviewReasons = { attach, defaults: DEFAULTS };
}());
