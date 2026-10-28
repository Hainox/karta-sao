/* Общее поведение панелей («худа») всех карт атласа. Подключается после atlas-hud.css.
   Всё работает поверх существующей разметки: карта ничего не меняет в своей логике,
   а панель получает запоминание разделов, всплывающие сообщения и подсветку подсказок. */
(() => {
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* приватный режим */ } },
  };

  /** Разделы <details class="hud-section" data-hud-key> помнят, открыты ли они. */
  function sections(root = document) {
    root.querySelectorAll('details.hud-section[data-hud-key]').forEach((box) => {
      const key = 'atlas-hud:' + box.dataset.hudKey;
      const saved = store.get(key);
      if (saved === 'open') box.open = true;
      if (saved === 'closed') box.open = false;
      box.addEventListener('toggle', () => store.set(key, box.open ? 'open' : 'closed'));
    });
  }

  /** Строка состояния превращается во всплывающее сообщение внизу экрана. */
  function toast(el) {
    if (!el) return;
    el.classList.add('hud-toast');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    let timer = 0;
    const show = () => {
      if (!el.textContent.trim()) return;
      el.classList.add('show');
      clearTimeout(timer);
      // Длинный текст держим дольше: успеть прочитать в любом возрасте.
      timer = setTimeout(() => el.classList.remove('show'), 3500 + el.textContent.length * 45);
    };
    new MutationObserver(show).observe(el, { childList: true, characterData: true, subtree: true });
    el.addEventListener('click', () => el.classList.remove('show'));
    show();
  }

  /** Подсказка мягко подсвечивается, когда меняется её текст. */
  function flash(el) {
    if (!el) return;
    el.setAttribute('aria-live', 'polite');
    let last = el.textContent;
    new MutationObserver(() => {
      if (el.textContent === last) return;
      last = el.textContent;
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }

  /** Кнопка «Просмотр» активна, когда ни один из режимов правки не включён. */
  function viewMode(viewButton, modeButtons) {
    if (!viewButton) return;
    const sync = () => {
      const editing = modeButtons.some((b) => b && !b.hidden && b.classList.contains('active'));
      viewButton.classList.toggle('active', !editing);
      viewButton.setAttribute('aria-pressed', String(!editing));
      modeButtons.forEach((b) => b && b.setAttribute('aria-pressed', String(b.classList.contains('active'))));
    };
    const observer = new MutationObserver(sync);
    modeButtons.forEach((b) => b && observer.observe(b, { attributes: true, attributeFilter: ['class', 'hidden'] }));
    sync();
  }

  window.AtlasHud = { sections, toast, flash, viewMode, store };
})();
