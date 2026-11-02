// Точки в одном месте (две стрелки из одной точки, например разные направления
// съёмки с одного угла) рисуются друг на друге, и нижнюю не нажать. Такие точки
// разъезжаются на экране на несколько пикселей: каждая — в сторону своей стрелки,
// а если стрелки смотрят почти одинаково — веером по кругу. Координаты в базе
// не меняются, сдвиг только у значка на карте.
window.spreadStackedPoints = function (items, { radiusPx = 13, nearM = 2 } = {}) {
  const groups = [];
  for (const item of items) {
    if (!item.element || !Number.isFinite(item.lng) || !Number.isFinite(item.lat)) continue;
    item.element.style.translate = '';
    const kx = 111320 * Math.cos(item.lat * Math.PI / 180);
    const group = groups.find((g) => Math.hypot((g[0].lng - item.lng) * kx, (g[0].lat - item.lat) * 110540) < nearM);
    if (group) group.push(item); else groups.push([item]);
  }
  const turn = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  for (const group of groups) {
    if (group.length < 2) continue;
    const headings = group.map((item) => Number(item.heading));
    const own = headings.every(Number.isFinite)
      && headings.every((a, i) => headings.every((b, j) => i === j || turn(a, b) >= 40));
    group.forEach((item, index) => {
      const angle = (own ? headings[index] : (Number.isFinite(headings[0]) ? headings[0] : 0) + (360 * index) / group.length) * Math.PI / 180;
      // Азимут: 0° — север (вверх на экране), 90° — восток (вправо).
      item.element.style.translate = `${(Math.sin(angle) * radiusPx).toFixed(1)}px ${(-Math.cos(angle) * radiusPx).toFixed(1)}px`;
      item.element.classList.add('stacked');
    });
  }
};
