/* Visual language for routes: travel direction and the rotor nozzle direction. */
(function () {
  'use strict';

  function pointOnLine(coordinates, fraction) {
    const lengths = [];
    let total = 0;
    for (let index = 1; index < coordinates.length; index += 1) {
      const previous = coordinates[index - 1];
      const current = coordinates[index];
      const length = Math.hypot((current[0] - previous[0]) * Math.cos(current[1] * Math.PI / 180), current[1] - previous[1]);
      lengths.push(length); total += length;
    }
    let remaining = total * fraction;
    for (let index = 1; index < coordinates.length; index += 1) {
      const previous = coordinates[index - 1];
      const current = coordinates[index];
      const length = lengths[index - 1];
      if (remaining <= length || index === coordinates.length - 1) {
        const ratio = length ? remaining / length : 0;
        const point = [previous[0] + (current[0] - previous[0]) * ratio, previous[1] + (current[1] - previous[1]) * ratio];
        const angle = -Math.atan2(current[1] - previous[1], (current[0] - previous[0]) * Math.cos(point[1] * Math.PI / 180)) * 180 / Math.PI;
        return { point, angle };
      }
      remaining -= length;
    }
    return null;
  }

  function icon(className, html, size, anchor) {
    return L.divIcon({ className: '', html: `<span class="${className}">${html}</span>`, iconSize: size, iconAnchor: anchor });
  }

  function addMarker(group, point, markerIcon, title) {
    L.marker([point[1], point[0]], { icon: markerIcon, interactive: false, keyboard: false, title }).addTo(group);
  }

  function addTo(group, feature) {
    const properties = feature?.properties || {};
    const coordinates = feature?.geometry?.type === 'LineString' ? feature.geometry.coordinates : null;
    if (!coordinates || coordinates.length < 2) return;
    const start = properties.route_start || coordinates[0];
    const end = properties.route_end || coordinates.at(-1);
    addMarker(group, start, icon('route-endpoint start', '<b>НАЧАЛО</b>', [66, 28], [33, 14]), 'Начало маршрута');
    addMarker(group, end, icon('route-endpoint end', '<b>КОНЕЦ</b>', [58, 28], [29, 14]), 'Конец маршрута');
    [0.34, 0.68].forEach((fraction) => {
      const position = pointOnLine(coordinates, fraction);
      if (!position) return;
      addMarker(group, position.point, icon('route-travel-arrow', `<i style="transform:rotate(${position.angle}deg)">➜</i>`, [34, 34], [17, 17]), 'Направление движения: от начала к концу');
    });
    const nozzlePosition = pointOnLine(coordinates, 0.51);
    if (!nozzlePosition) return;
    const nozzle = properties.nozzle_direction || 'both';
    const sides = nozzle === 'both' ? ['left', 'right'] : [nozzle];
    sides.forEach((side) => {
      const angle = nozzlePosition.angle + (side === 'left' ? -90 : 90);
      addMarker(group, nozzlePosition.point, icon(`route-nozzle-arrow ${side}`, `<i style="transform:rotate(${angle}deg)">➜</i>`, [34, 34], [17, 17]), `Направление сопла: ${side === 'left' ? 'влево по ходу' : 'вправо по ходу'}`);
    });
  }

  window.ODHRouteVisuals = { addTo };
})();
