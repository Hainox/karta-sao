// Правка точки прямо на карте: префектура выбирает точку одним кликом, тащит её
// на новое место и поворачивает стрелку за круглую ручку на её конце. Каждое
// изменение сохраняется само, внизу появляется «Сохранено · Отменить».
// Карточка точки на время перетаскивания прячется и потом встаёт у точки заново.
//
//   const editor = createPointEditor({ map, popover, host: document.body });
//   editor.select({ key, coordinates, heading, element, save: async ({ coordinates, heading }) => {...} });
//   new YMapMarker({ coordinates, draggable: editor.isSelected(key), ...editor.dragHandlers(key) }, element);
window.createPointEditor = function ({ map, popover, host = document.body }) {
  const KNOB_PX = 72;
  let target = null;
  let knob = null;
  let knobElement = null;
  let saving = Promise.resolve();
  let keyTimer = 0;
  let keyBefore = null;
  let keyPoint = null;

  const norm = (deg) => ((Math.round(deg) % 360) + 360) % 360;
  function bearing(from, to) {
    const dx = (to[0] - from[0]) * Math.cos(from[1] * Math.PI / 180);
    const dy = to[1] - from[1];
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }
  /** Точка на KNOB_PX экранных пикселей от центра по азимуту: метров в пикселе — 156543·cos(φ)/2^z. */
  function knobCoordinates(center, heading) {
    const zoom = Number(map.zoom) || 16;
    const metres = KNOB_PX * 156543.03 * Math.cos(center[1] * Math.PI / 180) / 2 ** zoom;
    const rad = heading * Math.PI / 180;
    return [
      center[0] + (metres * Math.sin(rad)) / (111320 * Math.cos(center[1] * Math.PI / 180)),
      center[1] + (metres * Math.cos(rad)) / 110540,
    ];
  }

  /* ---------- Тост «Сохранено · Отменить» ---------- */
  const toast = document.createElement('div');
  toast.className = 'edit-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = '<span class="edit-toast-text"></span><button type="button" class="edit-toast-undo">Отменить</button>';
  host.append(toast);
  let toastTimer = 0;
  let undo = null;
  function say(text, undoAction = null, kind = 'ok') {
    toast.querySelector('.edit-toast-text').textContent = text;
    toast.querySelector('.edit-toast-undo').hidden = !undoAction;
    toast.dataset.kind = kind;
    undo = undoAction;
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), undoAction ? 7000 : 3500);
  }
  toast.querySelector('.edit-toast-undo').addEventListener('click', () => {
    const action = undo;
    undo = null;
    toast.classList.remove('show');
    if (action) action();
  });

  /** Изменение уходит на сервер по очереди: быстрый поворот и перенос не обгоняют друг друга.
      «Отменить» отправляет прежние значения той же точки, даже если выбрана уже другая. */
  function commit(point, change, previous, doneText) {
    if (!point) return;
    saving = saving.then(async () => {
      say('Сохраняем…', null, 'busy');
      apply(point, change);
      try {
        await point.save(change);
        say(doneText, () => commit(point, previous, change, 'Вернули как было'));
      } catch (error) {
        say('Не сохранено: ' + error.message, null, 'bad');
        apply(point, previous);
      }
    });
  }
  function apply(point, values) {
    if (values.coordinates) point.coordinates = [...values.coordinates];
    if (values.heading != null) point.heading = values.heading;
    if (point !== target) return;
    paint();
    if (values.coordinates) popover?.setAnchor?.(point.coordinates);
  }

  /* ---------- Ручка поворота ---------- */
  function placeKnob() {
    if (!knob || !target) return;
    knob.update({ coordinates: knobCoordinates(target.coordinates, target.heading ?? 0) });
  }
  function paint() {
    if (!target) return;
    const arrow = target.element?.querySelector('.shoot-arrow');
    if (arrow && target.heading != null) arrow.style.transform = 'rotate(' + target.heading + 'deg)';
    if (knobElement) knobElement.style.setProperty('--heading', (target.heading ?? 0) + 'deg');
    popover?.setHeading?.(target.heading);
    placeKnob();
  }

  function addKnob() {
    removeKnob();
    if (!target || target.heading == null || !window.ymaps3?.YMapMarker) return;
    knobElement = document.createElement('button');
    knobElement.type = 'button';
    knobElement.className = 'rot-knob';
    knobElement.title = 'Тяните, чтобы повернуть стрелку. Стрелки на клавиатуре — по 5°.';
    knobElement.setAttribute('aria-label', 'Повернуть направление кадра');
    knobElement.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4v4h-4"/></svg>';
    knobElement.addEventListener('click', (event) => event.stopPropagation());
    let before = null;
    knob = new window.ymaps3.YMapMarker({
      coordinates: knobCoordinates(target.coordinates, target.heading),
      draggable: true,
      mapFollowsOnDrag: false,
      zIndex: 4000,
      onDragStart: () => { before = target?.heading; host.classList.add('point-dragging'); popover?.setDimmed?.(true); },
      onDragMove: (coordinates) => {
        if (!target) return;
        target.heading = norm(bearing(target.coordinates, coordinates));
        const arrow = target.element?.querySelector('.shoot-arrow');
        if (arrow) arrow.style.transform = 'rotate(' + target.heading + 'deg)';
        knobElement.style.setProperty('--heading', target.heading + 'deg');
        knobElement.dataset.deg = target.heading + '°';
        popover?.setHeading?.(target.heading);
      },
      onDragEnd: (coordinates) => {
        host.classList.remove('point-dragging');
        popover?.setDimmed?.(false);
        if (!target) return;
        target.heading = norm(bearing(target.coordinates, coordinates));
        delete knobElement.dataset.deg;
        paint();
        if (before != null && before !== target.heading) commit(target, { heading: target.heading }, { heading: before }, `Направление ${target.heading}° сохранено`);
      },
    }, knobElement);
    map.addChild(knob);
  }
  function removeKnob() {
    if (knob) { try { map.removeChild(knob); } catch (_) { /* уже снята */ } }
    knob = null;
    knobElement = null;
  }

  /* ---------- Выбор точки ---------- */
  function select(next) {
    flushKeys();
    clear();
    target = { ...next, coordinates: [...next.coordinates], heading: next.heading == null ? null : norm(next.heading) };
    target.element?.classList.add('selected');
    addKnob();
  }
  function clear() {
    if (keyPoint) flushKeys();
    if (target?.element) target.element.classList.remove('selected');
    target = null;
    removeKnob();
  }
  /** Слой перерисовал маркер выбранной точки — ручки цепляются к новому элементу. */
  function attach(key, element, fresh = {}) {
    if (!target || target.key !== key) return;
    target.element = element;
    if (fresh.coordinates) target.coordinates = [...fresh.coordinates];
    if (fresh.heading != null) target.heading = norm(fresh.heading);
    element.classList.add('selected');
    if (!knob) addKnob(); else paint();
  }

  function dragHandlers(key) {
    let before = null;
    return {
      mapFollowsOnDrag: false,
      onDragStart: () => {
        if (!target || target.key !== key) return;
        before = [...target.coordinates];
        host.classList.add('point-dragging');
        popover?.setDimmed?.(true);
      },
      onDragMove: (coordinates) => {
        if (!target || target.key !== key) return;
        target.coordinates = [...coordinates];
        placeKnob();
      },
      onDragEnd: (coordinates) => {
        host.classList.remove('point-dragging');
        if (!target || target.key !== key) { popover?.setDimmed?.(false); return; }
        target.coordinates = [...coordinates];
        target.suppressClick = true;
        placeKnob();
        popover?.setAnchor?.(target.coordinates);
        popover?.setDimmed?.(false);
        if (before) commit(target, { coordinates: target.coordinates }, { coordinates: before }, 'Точка перенесена');
        before = null;
      },
    };
  }

  /** Клик после перетаскивания браузер шлёт как обычный — его пропускаем один раз. */
  function takeSuppressedClick(key) {
    if (target?.key === key && target.suppressClick) { target.suppressClick = false; return true; }
    return false;
  }

  // Стрелки клавиатуры поворачивают выбранную точку на 5° (с Shift — на 15°), сохраняется через полсекунды.
  document.addEventListener('keydown', (event) => {
    if (!target || target.heading == null || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    event.preventDefault();
    if (keyPoint !== target) { keyPoint = target; keyBefore = target.heading; }
    target.heading = norm(target.heading + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 15 : 5));
    paint();
    clearTimeout(keyTimer);
    keyTimer = setTimeout(flushKeys, 500);
  });
  function flushKeys() {
    clearTimeout(keyTimer);
    const point = keyPoint;
    keyPoint = null;
    if (point && keyBefore !== point.heading) commit(point, { heading: point.heading }, { heading: keyBefore }, `Направление ${point.heading}° сохранено`);
  }

  return {
    select,
    clear,
    attach,
    dragHandlers,
    takeSuppressedClick,
    say,
    isSelected: (key) => Boolean(target && target.key === key),
    /** Зум поменялся — ручка держится на том же расстоянии в пикселях. */
    reposition: placeKnob,
    current: () => target,
  };
};
