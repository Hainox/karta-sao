(function () {
  'use strict';
  window.SaoPhotoAssignments = {
    mount({ dataset, getMap, notify, openRecord, closeRecord, applyScope, onChange }) {
      const panel = document.getElementById('assignmentPanel');
      const session = document.getElementById('assignmentSession');
      const list = document.getElementById('assignmentList');
      const picker = document.getElementById('assignmentPicker');
      const status = document.getElementById('assignmentStatus');
      let selected = null;
      let points = [];
      let picking = null;
      let layer = null;
      let preview = null;
      let revision = 0;
      let urls = [];
      let visibleObjects = null;
      const api = window.TpuPhotoApi || window.ODHApi;
      let markerLayout;
      const isPrefecture = () => api.user()?.role === 'prefecture_admin';
      const message = (text, error = false) => { status.textContent = text; if (error) notify(text, true); };
      const clearUrls = () => { urls.forEach(URL.revokeObjectURL); urls = []; };
      const endpoint = '/api/object-photo-points';
      async function request(path = '', options) {
        const response = await api.request(endpoint + path, options);
        return response.status === 204 ? null : response.json();
      }
      function renderMap() {
        const map = getMap();
        if (!map || !window.ymaps) return;
        markerLayout ||= ymaps.templateLayoutFactory.createClass('<div class="assignment-marker"><svg class="assignment-direction" width="160" height="160" viewBox="0 0 160 160" style="display:$[properties.arrowDisplay];transform:rotate($[properties.heading]deg)" aria-hidden="true"><path d="M80 8 L59 38 L70 38 L70 80 L90 80 L90 38 L101 38 Z" fill="#ffcb00" stroke="#102e60" stroke-width="5" stroke-linejoin="round"/></svg><div class="assignment-map-point">$[properties.iconContent]</div></div>');
        if (!layer) { layer = new ymaps.GeoObjectCollection(); map.geoObjects.add(layer); }
        layer.removeAll();
        const counters = new Map();
        for (const point of points) {
          const record = dataset.records.find(record => record.id === point.object_key);
          if (!record) continue;
          if (visibleObjects && !visibleObjects.has(record.id)) continue;
          const number = (counters.get(point.object_key) || 0) + 1;
          counters.set(point.object_key, number);
          const marker = new ymaps.Placemark([Number(point.latitude), Number(point.longitude)], { iconContent: String(number), hintContent: 'Точка съёмки ' + number, heading: point.heading ?? 0, arrowDisplay: point.heading == null ? 'none' : 'block' }, { iconLayout: markerLayout, iconShape: { type: 'Circle', coordinates: [0, 0], radius: 24 }, zIndex: 2000 });
          marker.events.add('click', () => { if (!picking) openRecord(record); });
          layer.add(marker);
        }
      }
      function sessionUI() {
        const user = api.user();
        session.textContent = user ? `${user.email} · ${user.role === 'prefecture_admin' ? 'Префектура' : user.role === 'district_editor' ? (user.district === 'АвД САО' ? 'Организация ' : 'Район ') + user.district : 'Просмотр'}` : 'Вход по учётной записи оцифровки';
        document.getElementById('assignmentLogin').hidden = Boolean(user);
        document.getElementById('assignmentAccount').hidden = Boolean(user);
        document.getElementById('assignmentLogout').hidden = !user;
        document.getElementById('assignmentAdd').hidden = !isPrefecture();
        applyScope(user);
      }
      async function refresh() {
        const version = ++revision;

        message('Загружаем назначенные точки…');
        try {
          const data = await request(api.user() ? '?dataset=' + encodeURIComponent(dataset.datasetId) : '/public');
          if (version !== revision) return;
          points = data.points;
          onChange(points);
          renderMap(); renderList();
          message('Назначенных точек: ' + points.length);
        } catch (error) { if (version === revision) message('Не удалось загрузить точки: ' + error.message, true); }
      }
      async function showPhotos(point, target, version) {
        try {
          const { photos } = await request('/' + point.id + '/photos');
          if (version !== revision || !target.isConnected) return;
          if (!photos.length) { target.textContent = 'Фото пока нет.'; return; }
          const canDelete = isPrefecture();
          for (const photo of photos) {
            const response = await api.request(endpoint + '/' + point.id + '/photos/' + photo.id);
            const blob = await response.blob();
            if (version !== revision || !target.isConnected) return;
            const url = URL.createObjectURL(blob); urls.push(url);
            const link = document.createElement('a'); link.href = url; link.download = photo.photo_filename || 'photo.jpg';
            const image = document.createElement('img'); image.src = url; image.alt = 'Фото: ' + point.label; image.loading = 'lazy';
            link.append(image);
            if (photo.assignment_version && photo.assignment_version !== point.assignment_version) {
              const note = document.createElement('small'); note.textContent = 'Фото до изменения точки или направления'; link.append(note);
            }
            if (!canDelete) { target.append(link); continue; }
            const card = document.createElement('div'); card.className = 'assignment-photo'; card.append(link);
            const remove = button('Удалить фото', async () => {
              if (!confirm('Удалить фото точки «' + point.label + '»? Точка съёмки и направление (стрелка) останутся на месте.')) return;
              remove.disabled = true;
              try { await request('/' + point.id + '/photos/' + photo.id, { method: 'DELETE' }); notify('Фото удалено. Точка съёмки и направление сохранены.'); await refresh(); }
              catch (error) { message(error.message, true); remove.disabled = false; }
            });
            remove.className = 'assignment-photo-remove';
            card.append(remove);
            target.append(card);
          }
        } catch (error) { if (target.isConnected) target.textContent = 'Не удалось загрузить фотографии: ' + error.message; }
      }
      function button(label, action) {
        const element = document.createElement('button'); element.type = 'button'; element.className = 'secondary-btn'; element.textContent = label; element.onclick = action; return element;
      }
      function renderList() {
        clearUrls(); list.replaceChildren();
        if (!selected) return;
        if (!api.user()) { const hint = document.createElement('p'); hint.textContent = 'Точки съёмки доступны на карте. Для отправки фото войдите в учётную запись.'; list.append(hint); }
        const assigned = points.filter(point => point.object_key === selected.id);
        if (!assigned.length) list.textContent = 'Точки съёмки ещё не назначены.';
        assigned.forEach((point, index) => {
          const card = document.createElement('article'); card.className = 'assignment-card';
          const heading = document.createElement('strong'); heading.textContent = `${index + 1}. ${point.label}`;
          const note = document.createElement('p'); note.textContent = point.note || '';
          const coords = document.createElement('small'); coords.textContent = `${Number(point.latitude).toFixed(6)}, ${Number(point.longitude).toFixed(6)}`;
          const actions = document.createElement('div'); actions.className = 'form-actions';
          actions.append(button('Показать на карте', () => { closeRecord(); getMap()?.setCenter([Number(point.latitude), Number(point.longitude)], 19); }));
          if (isPrefecture()) {
            actions.append(button('Изменить', () => begin(point)));
            actions.append(button('Снять назначение', async () => {
              if (!confirm('Снять назначение точки «' + point.label + '»?')) return;
              try { await request('/' + point.id, { method: 'DELETE' }); await refresh(); }
              catch (error) { message(error.message, true); }
            }));
          }
          const gallery = document.createElement('div'); gallery.className = 'assignment-photos';
          card.append(heading, note, coords, actions); if (api.user()) card.append(gallery);
          if (api.user()?.role === 'district_editor' && api.user().district === point.district) {
            const label = document.createElement('label'); label.textContent = 'Отправить фото этой точки (JPEG, PNG, WEBP, до 5 МБ)';
            const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.setAttribute('capture', 'environment');
            input.onchange = async () => {
              const file = input.files[0]; if (!file) return;
              if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { notify('Выберите JPEG, PNG или WEBP размером до 5 МБ.', true); input.value = ''; return; }
              input.disabled = true;
              try {
                await request('/' + point.id + '/photos', { method: 'PUT', headers: { 'Content-Type': file.type, 'X-Photo-Filename': encodeURIComponent(file.name), 'X-Assignment-Version': String(point.assignment_version) }, body: file });
                notify('Фото отправлено к точке «' + point.label + '».'); await refresh();
              } catch (error) { notify('Фото не отправлено: ' + error.message, true); input.disabled = false; await refresh(); }
            };
            label.append(input); card.append(label);
          }
          list.append(card); if (api.user()) showPhotos(point, gallery, revision);
        });
      }
      function cancel() {
        if (picking?.saving) return;
        picking = null; picker.hidden = true;
        const map = getMap(); if (preview && map) map.geoObjects.remove(preview); preview = null;
      }
      function renderPicker() {
        const save = document.getElementById('assignmentSave');
        save.disabled = picking.stage === 'position' || !picking.coordinates || picking.heading == null;
        document.getElementById('assignmentCoords').textContent = picking.coordinates
          ? picking.coordinates.map(v => Number(v).toFixed(6)).join(', ')
          : 'Нажмите на карте в месте съёмки';
        document.getElementById('assignmentDirection').textContent = picking.stage === 'position'
          ? 'Шаг 1: поставьте точку на карте.'
          : picking.heading == null
            ? 'Шаг 2: нажмите на карте в сторону, куда нужно фотографировать.'
            : 'Направление: ' + Math.round(picking.heading) + '°. Нажмите на карте, чтобы повернуть стрелку.';
        const map = getMap();
        if (preview) map.geoObjects.remove(preview);
        preview = null;
        if (picking.coordinates) {
          renderMap();
          preview = new ymaps.Placemark(picking.coordinates, {
            iconContent: '•', heading: picking.heading ?? 0,
            arrowDisplay: picking.heading == null ? 'none' : 'block'
          }, { iconLayout: markerLayout, iconShape: { type: 'Circle', coordinates: [0, 0], radius: 24 }, zIndex: 3000 });
          map.geoObjects.add(preview);
        }
      }
      function pick(coordinates) {
        if (!picking) return false;
        if (picking.saving) return true;
        if (picking.stage === 'position') {
          picking.coordinates = coordinates;
          picking.heading = null;
          picking.stage = 'direction';
        } else {
          const rad = Math.PI / 180;
          const [latitude, longitude] = picking.coordinates;
          const delta = (coordinates[1] - longitude) * rad;
          const y = Math.sin(delta) * Math.cos(coordinates[0] * rad);
          const x = Math.cos(latitude * rad) * Math.sin(coordinates[0] * rad)
            - Math.sin(latitude * rad) * Math.cos(coordinates[0] * rad) * Math.cos(delta);
          if (Math.hypot(x, y) < 0.0000003) {
            notify('Укажите направление чуть дальше от точки съёмки.', true);
            return true;
          }
          picking.heading = (Math.atan2(y, x) / rad + 360) % 360;
        }
        renderPicker();
        return true;
      }
      function begin(point = null) {
        if (!isPrefecture() || !selected) return;
        if (picking?.saving) return;
        cancel();
        picking = { record: selected, point, coordinates: point ? [Number(point.latitude), Number(point.longitude)] : null,
          heading: point?.heading == null ? null : Number(point.heading), stage: point ? 'direction' : 'position' };
        document.getElementById('assignmentLabel').value = point?.label || '';
        document.getElementById('assignmentNote').value = point?.note || '';
        document.getElementById('assignmentObject').textContent = selected.label;
        closeRecord(); picker.hidden = false;
        if (matchMedia('(max-width: 850px)').matches) document.getElementById('map')?.scrollIntoView({ block: 'start' });
        getMap()?.setCenter(point ? picking.coordinates : [selected.lat, selected.lon], 18);
        renderPicker();
      }
      document.getElementById('assignmentMove').onclick = () => {
        if (!picking || picking.saving) return;
        picking.stage = 'position'; picking.heading = null; renderPicker();
      };
      document.getElementById('assignmentAdd').onclick = () => begin();
      document.getElementById('assignmentCancel').onclick = cancel;
      document.getElementById('assignmentForm').onsubmit = async event => {
        event.preventDefault(); if (!picking?.coordinates || picking.heading == null || picking.stage === 'position') return;
        const assignment = picking;
        const account = api.user()?.email;
        const label = document.getElementById('assignmentLabel').value.trim();
        if (!label) return notify('Введите название точки съёмки.', true);
        const body = { datasetId: dataset.datasetId, objectKey: assignment.record.id, district: assignment.record.group, objectType: assignment.record.kind, latitude: assignment.coordinates[0], longitude: assignment.coordinates[1], label, heading: assignment.heading, note: document.getElementById('assignmentNote').value.trim() };
        const save = document.getElementById('assignmentSave'); save.disabled = true;
        assignment.saving = true;
        document.getElementById('assignmentCancel').disabled = true;
        document.getElementById('assignmentLogout').disabled = true;
        try {
          const payload = assignment.point ? { latitude: body.latitude, longitude: body.longitude, label: body.label, note: body.note, heading: body.heading } : body;
          await request(assignment.point ? '/' + assignment.point.id : '', { method: assignment.point ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
          if (picking !== assignment || api.user()?.email !== account) return;
          assignment.saving = false;
          cancel(); await refresh(); openRecord(assignment.record); notify('Точка съёмки сохранена.');
        } catch (error) { notify('Не удалось сохранить точку: ' + error.message, true); }
        finally { assignment.saving = false; save.disabled = false; document.getElementById('assignmentCancel').disabled = false; document.getElementById('assignmentLogout').disabled = false; }
      };
      document.getElementById('assignmentLogin').onsubmit = async event => {
        event.preventDefault(); const password = document.getElementById('assignmentPassword');
        const submit = event.currentTarget.querySelector('button'); submit.disabled = true;
        try { await api.login(document.getElementById('assignmentEmail').value.trim(), password.value); password.value = ''; sessionUI(); await refresh(); }
        catch (error) { message('Вход не выполнен: ' + error.message, true); }
        finally { password.value = ''; submit.disabled = false; }
      };
      document.getElementById('assignmentLogout').onclick = () => { cancel(); api.clearSession(); revision++; sessionUI(); refresh(); message('Вы вышли из учётной записи.'); };
      sessionUI();
      if (api.user()) api.request('/api/me').then(() => refresh()).catch(error => { api.clearSession(); sessionUI(); refresh(); message('Войдите повторно: ' + error.message, true); }); else refresh();
      return {
        open(record) { selected = record; renderList(); panel.hidden = false; },
        mapReady() { getMap().events.add('click', event => pick(event.get('coords'))); renderMap(); },
        pick, isPicking: () => Boolean(picking),
        filter(records) { visibleObjects = new Set(records.map(record => record.id)); renderMap(); },
      };
    },
  };
}());
