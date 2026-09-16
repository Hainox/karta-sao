/* Единый визуальный язык объектов разметки ОДХ.
 *
 * Отвечает за три вещи, одинаковые у района и у префектуры:
 *   — подпись объекта на карте (короткий код и номер, например «ОЧ-II №3»);
 *   — карточку объекта по клику: что это, к чему относится и кто отвечает;
 *   — легенду типов, собранную из единого словаря DistrictChanges.TYPES.
 *
 * Подписи работают в двух режимах: «все» и «по наведению».
 *
 * Постоянные подписи модуль держит в собственной группе слоёв, а не перевешивает
 * tooltip у объекта: перепривязка постоянного tooltip в Leaflet оставляет прежний
 * узел в DOM, и подпись задваивается. Своей группой мы управляем полностью.
 */
(function () {
  'use strict';

  const MODE_ALL = 'all';
  const MODE_HOVER = 'hover';
  /** При большем числе объектов постоянные подписи заслоняют карту. */
  const LABEL_LIMIT = 150;

  const STATUS_LABELS = {
    draft: 'Черновик района — ещё не отправлено',
    submitted: 'На приёмке у префектуры',
    approved: 'Утверждено префектурой',
    rejected: 'Отклонено префектурой',
    proposed: 'Предложение района — не опубликовано'
  };

  let currentMode = MODE_ALL;
  let labelGroup = null;
  const registry = [];

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function isRoute(feature) {
    return DistrictChanges.ROUTE_TYPES.has(feature?.properties?.change_type);
  }

  /** Выполняет действие над каждым вложенным слоем; одиночный слой — как есть. */
  function eachChild(layer, callback) {
    if (layer && typeof layer.eachLayer === 'function' && typeof layer.getLayers === 'function') layer.eachLayer(callback);
    else callback(layer);
  }

  function labelClass(feature) {
    return `object-label object-label-${DistrictChanges.groupOf(feature)}`;
  }

  /** Текст подписи на карте: «ОЧ-II №3 · Дмитровское ш., у д. 90». */
  function labelText(feature, index) {
    const badge = DistrictChanges.badgeFor(feature, index);
    const address = String(feature?.properties?.address ?? '').trim();
    return address ? `${badge} · ${address}` : badge;
  }

  /** Карточка объекта: что это, к чему относится, кто отвечает. */
  function popupHtml(feature, context = {}) {
    const properties = feature?.properties || {};
    const type = DistrictChanges.typeOf(feature);
    const style = DistrictChanges.styleFor(feature);
    const badge = DistrictChanges.badgeFor(feature, context.index);
    const rows = [];

    const priority = type?.priorityNames?.[String(properties.queue_priority)];
    if (priority) rows.push(['Очередь уборки', priority]);

    const route = DistrictChanges.routeFactsFor(feature);
    if (route) {
      rows.push(['Направление', route.direction]);
      rows.push(['Сопло', route.nozzle]);
    }
    if (properties.address) rows.push(['Адрес или ориентир', properties.address]);
    if (context.district || properties.district) rows.push(['Район', context.district || properties.district]);
    if (context.balanceHolder) rows.push(['Балансодержатель', context.balanceHolder]);
    if (context.author || properties.author) rows.push(['Исполнитель', context.author || properties.author]);
    if (context.setName) rows.push(['Набор', context.setName]);
    if (context.submittedAt) rows.push(['Отправлен', context.submittedAt]);

    const statusKey = context.status || 'proposed';
    const statusText = context.statusLabel || STATUS_LABELS[statusKey] || STATUS_LABELS.proposed;

    return [
      '<div class="object-popup">',
      '<div class="object-popup-head">',
      `<span class="object-badge" style="--object-color:${esc(style.color)}">${esc(badge)}</span>`,
      `<span class="object-popup-title">${esc(type?.label || 'Неизвестный объект')}</span>`,
      '</div>',
      type?.purpose ? `<p class="object-popup-purpose">${esc(type.purpose)}</p>` : '',
      '<dl class="object-popup-rows">',
      rows.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join(''),
      '</dl>',
      properties.comment ? `<p class="object-popup-comment"><b>Комментарий:</b> ${esc(properties.comment)}</p>` : '',
      `<p class="object-popup-status" data-status="${esc(statusKey)}">${esc(statusText)}</p>`,
      '</div>'
    ].join('');
  }

  /** Текст для легенды и списков: код, название и за что объект отвечает. */
  function legendRows() {
    const rows = [];
    for (const [key, type] of Object.entries(DistrictChanges.TYPES)) {
      if (type.colors) {
        Object.entries(type.colors).forEach(([priority, color]) => {
          rows.push({
            key, color, dashArray: null, group: type.group,
            code: type.shortByPriority?.[priority] || type.short,
            label: `${type.label} — ${type.priorityNames?.[priority] || priority}`,
            purpose: type.purpose
          });
        });
        continue;
      }
      rows.push({ key, color: type.color, dashArray: type.dashArray || null, group: type.group, code: type.short, label: type.label, purpose: type.purpose });
    }
    return rows;
  }

  function latLngOf(child) {
    if (typeof child.getLatLng === 'function') return child.getLatLng();
    if (typeof child.getCenter === 'function') return child.getCenter();
    if (typeof child.getBounds === 'function') {
      const bounds = child.getBounds();
      if (bounds?.isValid()) return bounds.getCenter();
    }
    return null;
  }

  /** Карта, на которой сейчас лежит объект; null — объект ещё не показан. */
  function mapOf(entry) {
    let found = null;
    eachChild(entry.layer, (child) => { if (!found && child._map) found = child._map; });
    return found;
  }

  function labelsLayer() {
    if (!labelGroup) labelGroup = L.layerGroup();
    return labelGroup;
  }

  function hoverOptions(feature) {
    return { permanent: false, direction: 'top', sticky: true, opacity: 1, className: labelClass(feature) };
  }

  /**
   * Пересобирает подписи по текущему режиму. Вызывается после того, как слои
   * попали на карту, и при смене режима.
   *
   * Постоянная подпись — маркер с divIcon, а не tooltip: снятие tooltip-слоя не
   * убирает его узел из DOM, и подпись задваивается. Маркеры удаляются из группы
   * полностью — тот же приём, что и у меток маршрута в route-visuals.js.
   */
  function refresh() {
    const group = labelsLayer();
    group.clearLayers();
    registry.forEach((entry) => {
      const map = mapOf(entry);
      eachChild(entry.layer, (child) => {
        if (typeof child.unbindTooltip !== 'function') return;
        child.unbindTooltip();
        if (currentMode === MODE_HOVER) {
          child.bindTooltip(entry.text, hoverOptions(entry.feature));
          return;
        }
        if (!map) return;
        if (!group._map) group.addTo(map);
        const latlng = latLngOf(child);
        if (!latlng) return;
        group.addLayer(L.marker(latlng, {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: '',
            html: `<span class="object-label object-label-pin ${labelClass(entry.feature)}">${esc(entry.text)}</span>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
          })
        }));
      });
    });
  }

  /**
   * Вешает на слой карточку объекта и запоминает подпись.
   * group — слой, в который нужно дорисовать метки маршрута (НАЧАЛО/КОНЕЦ, стрелки).
   */
  function attach(layer, feature, context = {}, options = {}) {
    layer.bindPopup(popupHtml(feature, context));
    registry.push({ layer, feature, text: labelText(feature, context.index) });
    // Метки маршрута рисуем здесь же, чтобы у объекта был один владелец визуализации.
    if (options.group && isRoute(feature)) ODHRouteVisuals.addTo(options.group, feature);
    return registry.at(-1);
  }

  function clear() {
    registry.length = 0;
    if (labelGroup) labelGroup.clearLayers();
  }

  /**
   * Открывает карточку объекта. Карточка висит на группе слоёв, а Leaflet умеет
   * открывать её у группы: он сам подставляет вложенный слой с координатой.
   */
  function openPopup(layer) {
    if (layer && typeof layer.openPopup === 'function') layer.openPopup();
  }

  function getMode() {
    return currentMode;
  }

  /** Переключает режим подписей, не пересоздавая слои объектов. */
  function setMode(next) {
    currentMode = next === MODE_HOVER ? MODE_HOVER : MODE_ALL;
    refresh();
    return currentMode;
  }

  /** Режим по умолчанию для набора: плотные наборы сразу открываются «по наведению». */
  function modeForCount(count) {
    return Number.isFinite(count) && count > LABEL_LIMIT ? MODE_HOVER : MODE_ALL;
  }

  function modeLabel(mode) {
    return mode === MODE_HOVER ? 'Подписи: по наведению' : 'Подписи: все';
  }

  function renderToggle(container, onChange) {
    if (!container) return null;
    container.replaceChildren();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'labels-toggle';
    button.dataset.mode = currentMode;
    button.textContent = modeLabel(currentMode);
    button.onclick = () => {
      const next = setMode(currentMode === MODE_ALL ? MODE_HOVER : MODE_ALL);
      button.dataset.mode = next;
      button.textContent = modeLabel(next);
      if (typeof onChange === 'function') onChange(next);
    };
    container.append(button);
    return button;
  }

  /** Легенда типов: цвет, код, название и назначение — из единого словаря. */
  function renderLegend(container) {
    if (!container) return;
    container.replaceChildren();
    const title = document.createElement('p');
    title.className = 'eyebrow';
    title.textContent = 'Что означает каждый объект';
    container.append(title);

    for (const [group, groupLabel] of Object.entries(DistrictChanges.GROUP_LABELS)) {
      const rows = legendRows().filter((row) => row.group === group);
      if (!rows.length) continue;
      const head = document.createElement('p');
      head.className = 'object-group-head';
      head.textContent = groupLabel;
      container.append(head);
      for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'type-legend-row';
        const swatch = document.createElement('i');
        swatch.style.background = row.color;
        if (row.dashArray) swatch.style.backgroundImage = `repeating-linear-gradient(90deg, ${row.color} 0 4px, transparent 4px 8px)`;
        const code = document.createElement('b');
        code.textContent = row.code;
        const text = document.createElement('span');
        text.textContent = row.label;
        const purpose = document.createElement('em');
        purpose.textContent = row.purpose;
        line.append(swatch, code, text, purpose);
        container.append(line);
      }
    }
  }

  window.ODHObjectLabels = {
    MODE_ALL, MODE_HOVER, LABEL_LIMIT,
    labelText, popupHtml, legendRows, attach, clear, openPopup, refresh, getMode, setMode, modeForCount, modeLabel, renderToggle, renderLegend
  };
}());
