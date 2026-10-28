// Мини-карточка точки на карте района: окно у самой точки вместо левого меню.
// Карточка — это элемент #card: его наполняют прежние обработчики (точки
// въездных групп, площадки ДП/СП, тротуары), а окно даёт шапку с видом точки,
// компас направления кадра и привязку к месту на карте. На узком экране окно
// становится нижней панелью.
window.createPointPopover = function ({ map, card, mapElement }) {
  const KINDS = {
    entrance: { label: 'Въездная группа', color: '#e0a800' },
    dp: { label: 'Детская площадка', color: '#2e9e52' },
    sp: { label: 'Спортивная площадка', color: '#1f78b4' },
    sidewalk: { label: 'Тротуар', color: '#7b4fc9' },
  };
  const narrow = window.matchMedia('(max-width: 720px)');
  const shell = document.createElement('div');
  shell.className = 'pin-pop';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-labelledby', 'pinTitle');
  shell.innerHTML = `<div class="pin-card">
      <header class="pin-head">
        <svg class="pin-dial" viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="24" cy="24" r="21" class="pin-dial-ring"/>
          <path d="M24 3.5v4M24 40.5v4M3.5 24h4M40.5 24h4" class="pin-dial-ticks"/>
          <text x="24" y="14.2" class="pin-dial-n">С</text>
          <g class="pin-dial-needle"><path d="M24 9 L29.5 25 L24 22.4 L18.5 25 Z"/></g>
          <circle cx="24" cy="24" r="2.6" class="pin-dial-hub"/>
        </svg>
        <div class="pin-titles">
          <p class="pin-kind"></p>
          <h2 id="pinTitle"></h2>
          <p class="pin-sub"></p>
        </div>
        <button type="button" class="pin-close" aria-label="Закрыть карточку">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>
        </button>
      </header>
      <div class="pin-body"></div>
    </div>
    <span class="pin-tail" aria-hidden="true"></span>`;
  const $ = (selector) => shell.querySelector(selector);
  // Закрытое окно ждёт в скрытом кармане: прежний код находит #card по id всегда.
  const parking = document.createElement('div');
  parking.hidden = true;
  document.body.append(parking);
  $('.pin-body').append(card);
  parking.append(shell);
  card.classList.add('pin-content');
  // Окно живёт поверх карты: клики, колесо и перетаскивание внутри него
  // не должны ставить точки, масштабировать или двигать карту.
  for (const type of ['click', 'dblclick', 'pointerdown', 'mousedown', 'touchstart', 'wheel', 'contextmenu']) {
    shell.addEventListener(type, (event) => event.stopPropagation(), { passive: type !== 'contextmenu' });
  }
  $('.pin-close').addEventListener('click', () => close());

  let marker = null;
  let anchor = null;
  let opened = false;

  function mount() {
    unmount();
    if (narrow.matches) {
      shell.classList.add('sheet');
      document.body.append(shell);
      return;
    }
    shell.classList.remove('sheet');
    const holder = document.createElement('div');
    holder.className = 'pin-anchor';
    holder.append(shell);
    marker = new window.ymaps3.YMapMarker({ coordinates: anchor, zIndex: 5000 }, holder);
    map.addChild(marker);
  }

  function unmount() {
    parking.append(shell);
    if (marker) { try { map.removeChild(marker); } catch (_) { /* уже снят */ } marker = null; }
  }

  /** Окно не вылезает за края карты: открывается туда, где больше места, высота
      подстраивается под это место, по горизонтали окно сдвигается внутрь карты. */
  function fit() {
    if (!opened || shell.classList.contains('sheet') || !shell.parentElement) return;
    const box = (mapElement || document.body).getBoundingClientRect();
    const pointY = shell.parentElement.getBoundingClientRect().top;
    const above = pointY - box.top - 34;
    const below = box.bottom - pointY - 34;
    const natural = $('.pin-card').scrollHeight;
    const flip = above < Math.min(natural, 360) && below > above;
    shell.classList.toggle('below', flip);
    shell.style.setProperty('--maxh', Math.max(180, Math.min(560, flip ? below : above)) + 'px');
    shell.style.setProperty('--dx', '0px');
    const rect = shell.getBoundingClientRect();
    let dx = 0;
    if (rect.left < box.left + 10) dx = box.left + 10 - rect.left;
    else if (rect.right > box.right - 10) dx = box.right - 10 - rect.right;
    shell.style.setProperty('--dx', Math.round(dx) + 'px');
  }

  function setHeading(heading) {
    const dial = $('.pin-dial');
    const value = Number(heading);
    // У SVG нет свойства hidden — только атрибут.
    const none = heading == null || heading === '' || !Number.isFinite(value);
    dial.toggleAttribute('hidden', none);
    if (!none) {
      $('.pin-dial-needle').setAttribute('transform', `rotate(${((value % 360) + 360) % 360} 24 24)`);
      dial.setAttribute('aria-label', `Направление кадра ${Math.round(value)}°`);
    }
  }

  function open({ coordinates, kind, title, subtitle = '', heading = null }) {
    const meta = KINDS[kind] || KINDS.entrance;
    shell.style.setProperty('--kind', meta.color);
    $('.pin-kind').textContent = meta.label;
    $('#pinTitle').textContent = title;
    $('.pin-sub').textContent = subtitle;
    $('.pin-sub').hidden = !subtitle;
    setHeading(heading);
    anchor = coordinates;
    opened = true;
    card.className = 'card open pin-content';
    mount();
    shell.classList.remove('enter');
    void shell.offsetWidth;
    shell.classList.add('enter');
    requestAnimationFrame(fit);
  }

  function close() {
    if (!opened) return;
    opened = false;
    unmount();
    if (card.classList.contains('open')) card.className = 'card pin-content';
  }

  // Прежние обработчики закрывают карточку, снимая класс open (Esc, удаление точки).
  new MutationObserver(() => {
    if (opened && !card.classList.contains('open')) close();
    else if (opened) requestAnimationFrame(fit);
  }).observe(card, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  narrow.addEventListener('change', () => { if (opened) { mount(); requestAnimationFrame(fit); } });

  return { open, close, setHeading, reposition: () => requestAnimationFrame(fit), isOpen: () => opened };
};
