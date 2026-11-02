(function () {
  'use strict';
  // Стрелки направления съёмки пока выключены: точка ставится одним кликом, направление
  // не запрашивается и не рисуется. Сохранённое ранее направление не стирается.
  const SHOW_DIRECTION = false;
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
      // Сводки в Excel — только для префектуры: по ТПУ и по парковкам отдельными файлами,
      // отдельно от отчётов ПП/ООТ/подъездов.
      const reportButtons = [];
      let reportAnchor = document.getElementById('assignmentLogout');
      for (const report of [
        { path: '/slots/report.xlsx', id: 'assignmentSlotReport', label: 'Excel: свод по фото (ТПУ и парковки)', file: 'Svod_foto_TPU_parkovki_', done: 'Свод по фото скачан.' },
        { kind: 'tpu', id: 'assignmentReport', label: 'Excel: сводка по ТПУ', file: 'Svodka_TPU_SAO_', done: 'Сводка по ТПУ скачана.' },
        { kind: 'parking', id: 'assignmentParkingReport', label: 'Excel: сводка по парковкам', file: 'Svodka_Parkovki_SAO_', done: 'Сводка по парковкам скачана.' },
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary-btn assignment-report';
        button.id = report.id;
        button.textContent = report.label;
        button.hidden = true;
        reportAnchor.after(button);
        reportAnchor = button;
        reportButtons.push(button);
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = 'Готовим сводку…';
          try {
            const response = await api.request(endpoint + (report.path || '/report.xlsx?kind=' + report.kind));
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = report.file + new Date().toISOString().slice(0, 10) + '.xlsx';
            document.body.append(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1500);
            notify(report.done);
          } catch (error) { notify('Не удалось получить сводку: ' + error.message, true); }
          finally { button.disabled = false; button.textContent = report.label; }
        });
      }
      // Архив фото парковок (ZIP): район → объект → «координаты объекта_N». Сервер
      // собирает файл в фоне, кнопка ждёт готовности и скачивает его по билету.
      const archiveButton = document.createElement('button');
      archiveButton.type = 'button';
      archiveButton.className = 'secondary-btn assignment-report';
      archiveButton.id = 'assignmentParkingArchive';
      const archiveLabel = 'Фото парковок (ZIP)';
      archiveButton.textContent = archiveLabel;
      archiveButton.hidden = true;
      reportAnchor.after(archiveButton);
      reportButtons.push(archiveButton);
      archiveButton.addEventListener('click', async () => {
        archiveButton.disabled = true;
        archiveButton.textContent = 'Собираем архив…';
        try {
          let job = await (await api.request('/parking/photos.zip/prepare', { method: 'POST' })).json();
          if (!job.total) throw new Error('по парковкам пока нет фото');
          const jobId = job.id;
          while (job.status === 'building') {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            job = await (await api.request('/parking/photos.zip/prepare/' + jobId)).json();
            archiveButton.textContent = 'Собираем архив: ' + (job.photos || 0) + ' из ' + job.total;
          }
          if (job.status !== 'ready') throw new Error(job.error || 'архив не собрался');
          const link = document.createElement('a');
          const base = typeof api.base === 'function' ? api.base() : api.base || '';
          link.href = base + '/reports/photos.zip/file/' + encodeURIComponent(job.name) + '?ticket=' + encodeURIComponent(job.ticket);
          document.body.append(link); link.click(); link.remove();
          notify('Архив готов: ' + job.photos + ' фото.');
        } catch (error) { notify('Не удалось собрать архив: ' + error.message, true); }
        finally { archiveButton.disabled = false; archiveButton.textContent = archiveLabel; }
      });
      async function request(path = '', options) {
        const response = await api.request(endpoint + path, options);
        return response.status === 204 ? null : response.json();
      }
      // Отмена последнего действия: тост «Сохранено · Отменить» внизу экрана, как на картах районов.
      const undoToast = document.createElement('div');
      undoToast.className = 'assignment-undo';
      undoToast.setAttribute('role', 'status');
      undoToast.setAttribute('aria-live', 'polite');
      undoToast.innerHTML = '<span></span><button type="button">Отменить</button>';
      document.body.append(undoToast);
      let undoAction = null;
      let undoTimer = 0;
      function saved(text, undo = null) {
        undoToast.querySelector('span').textContent = text;
        undoToast.querySelector('button').hidden = !undo;
        undoAction = undo;
        undoToast.classList.remove('show'); void undoToast.offsetWidth; undoToast.classList.add('show');
        clearTimeout(undoTimer);
        undoTimer = setTimeout(() => undoToast.classList.remove('show'), undo ? 7000 : 3500);
      }
      undoToast.querySelector('button').addEventListener('click', () => {
        const action = undoAction; undoAction = null; undoToast.classList.remove('show');
        if (action) action();
      });
      // Пока точку тащат, карточка объекта прозрачна: видно, куда ставить.
      const dim = (on) => document.getElementById('detailBackdrop')?.classList.toggle('dimmed', on);

      function renderMap() {
        const map = getMap();
        if (!map || !window.ymaps) return;
        markerLayout ||= ymaps.templateLayoutFactory.createClass('<div class="assignment-marker $[properties.cls]"><svg class="assignment-direction" width="160" height="160" viewBox="0 0 160 160" style="display:$[properties.arrowDisplay];transform:rotate($[properties.heading]deg)" aria-hidden="true"><path d="M80 8 L59 38 L70 38 L70 80 L90 80 L90 38 L101 38 Z" fill="#ffcb00" stroke="#102e60" stroke-width="5" stroke-linejoin="round"/></svg><div class="assignment-map-point">$[properties.iconContent]</div></div>');
        if (!layer) { layer = new ymaps.GeoObjectCollection(); map.geoObjects.add(layer); }
        layer.removeAll();
        const counters = new Map();
        for (const point of points) {
          const record = dataset.records.find(record => record.id === point.object_key);
          if (!record) continue;
          if (visibleObjects && !visibleObjects.has(record.id)) continue;
          const number = (counters.get(point.object_key) || 0) + 1;
          counters.set(point.object_key, number);
          // Точки открытого объекта префектура перетаскивает прямо мышью — сохраняется само.
          const editable = isPrefecture() && selected?.id === record.id && !picking;
          const marker = new ymaps.Placemark([Number(point.latitude), Number(point.longitude)], {
            iconContent: String(number), cls: editable ? 'selected' : '',
            hintContent: editable ? 'Точка съёмки ' + number + ': перетащите, чтобы перенести' : 'Точка съёмки ' + number,
            heading: point.heading ?? 0, arrowDisplay: SHOW_DIRECTION && point.heading != null ? 'block' : 'none',
          }, { iconLayout: markerLayout, iconShape: { type: 'Circle', coordinates: [0, 0], radius: 28 }, zIndex: editable ? 2500 : 2000, draggable: editable });
          marker.events.add('click', () => { if (!picking) openRecord(record); });
          if (editable) {
            marker.events.add('dragstart', () => dim(true));
            marker.events.add('dragend', () => { dim(false); move(point, marker.geometry.getCoordinates()); });
          }
          layer.add(marker);
        }
      }
      async function move(point, coordinates) {
        const before = [Number(point.latitude), Number(point.longitude)];
        try {
          await request('/' + point.id, { method: 'PATCH', body: JSON.stringify({ latitude: coordinates[0], longitude: coordinates[1] }) });
          await refresh();
          saved('Точка «' + point.label + '» перенесена', async () => {
            try { await request('/' + point.id, { method: 'PATCH', body: JSON.stringify({ latitude: before[0], longitude: before[1] }) }); await refresh(); saved('Вернули как было'); }
            catch (error) { notify('Не удалось вернуть: ' + error.message, true); }
          });
        } catch (error) { notify('Точка не перенесена: ' + error.message, true); await refresh(); }
      }
      function sessionUI() {
        const user = api.user();
        session.textContent = user ? `${user.email} · ${user.role === 'prefecture_admin' ? 'Префектура' : user.role === 'district_editor' ? (user.district === 'АвД САО' ? 'Организация ' : 'Район ') + user.district : 'Просмотр'}` : 'Вход по учётной записи оцифровки';
        document.getElementById('assignmentLogin').hidden = Boolean(user);
        document.getElementById('assignmentAccount').hidden = Boolean(user);
        document.getElementById('assignmentLogout').hidden = !user;
        document.getElementById('assignmentAdd').hidden = !isPrefecture();
        for (const button of reportButtons) button.hidden = !isPrefecture();
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
        } catch (error) { if (version === revision) message('Не удалось загрузить точки: ' + (/fetch|network/i.test(error.message) ? 'нет связи с сервером' : error.message), true); }
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
      function field(tag, value, caption, max) {
        const label = document.createElement('label'); label.className = 'assignment-field'; label.textContent = caption;
        const input = document.createElement(tag); input.value = value; input.maxLength = max; if (tag === 'textarea') input.rows = 2;
        label.append(input);
        return { label, input };
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
          actions.append(button('Показать на карте', () => getMap()?.setCenter([Number(point.latitude), Number(point.longitude)], Math.max(getMap().getZoom(), 18), { duration: 300 })));
          if (isPrefecture()) {
            // Название и что снимать правятся прямо в карточке и сохраняются сами.
            heading.textContent = `${index + 1}.`;
            const name = field('input', point.label, 'Название точки', 160);
            const what = field('textarea', point.note || '', 'Что сфотографировать', 2000);
            const edit = (key, input) => input.addEventListener('change', async () => {
              const value = input.value.trim();
              if (key === 'label' && !value) { input.value = point.label; notify('Название точки не может быть пустым.', true); return; }
              const before = point[key] || '';
              if (value === before) return;
              try {
                await request('/' + point.id, { method: 'PATCH', body: JSON.stringify({ [key]: value }) });
                point[key] = value;
                saved('Сохранено', async () => {
                  try { await request('/' + point.id, { method: 'PATCH', body: JSON.stringify({ [key]: before }) }); await refresh(); saved('Вернули как было'); }
                  catch (error) { notify('Не удалось вернуть: ' + error.message, true); }
                });
              } catch (error) { notify('Не сохранено: ' + error.message, true); input.value = before; }
            });
            edit('label', name.input); edit('note', what.input);
            heading.append(name.label);
            note.replaceChildren(what.label);
            const hint = document.createElement('small'); hint.className = 'assignment-hint'; hint.textContent = 'Чтобы перенести точку, перетащите её на карте — сохранится само.';
            actions.append(button('Снять назначение', async () => {
              if (!confirm('Снять назначение точки «' + point.label + '»?')) return;
              try { await request('/' + point.id, { method: 'DELETE' }); await refresh(); saved('Назначение снято'); }
              catch (error) { message(error.message, true); }
            }));
            card.append(heading, note, coords, hint, actions);
          } else card.append(heading, note, coords, actions);
          const gallery = document.createElement('div'); gallery.className = 'assignment-photos';
          if (api.user()) card.append(gallery);
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
      // Новая точка: «+ Поставить точку на карте» → один клик по карте → точка сохранена.
      // Карточка на время выбора места прячется, потом открывается снова.
      function cancel() {
        if (!picking || picking.saving) return;
        const record = picking.record;
        picking = null; picker.hidden = true; document.getElementById('map')?.classList.remove('assignment-placing');
        renderMap();
        if (record) openRecord(record);
      }
      async function place(coordinates) {
        const assignment = picking;
        assignment.saving = true;
        const record = assignment.record;
        const count = points.filter(point => point.object_key === record.id).length;
        const body = { datasetId: dataset.datasetId, objectKey: record.id, district: record.group, objectType: record.kind,
          latitude: coordinates[0], longitude: coordinates[1], label: 'Точка ' + (count + 1), heading: null, note: '' };
        try {
          const created = await request('', { method: 'POST', body: JSON.stringify(body) });
          picking = null; picker.hidden = true; document.getElementById('map')?.classList.remove('assignment-placing');
          await refresh(); openRecord(record);
          const id = created?.point?.id;
          saved('Точка поставлена', id ? async () => {
            try { await request('/' + id, { method: 'DELETE' }); await refresh(); saved('Точка убрана'); }
            catch (error) { notify('Не удалось убрать точку: ' + error.message, true); }
          } : null);
        } catch (error) { assignment.saving = false; notify('Точка не сохранена: ' + error.message, true); }
      }
      function pick(coordinates) {
        if (!picking) return false;
        if (!picking.saving) place(coordinates);
        return true;
      }
      function begin() {
        if (!isPrefecture() || !selected || picking) return;
        picking = { record: selected };
        closeRecord(); picker.hidden = false;
        document.getElementById('map')?.classList.add('assignment-placing');
        renderMap();
        if (matchMedia('(max-width: 850px)').matches) document.getElementById('map')?.scrollIntoView({ block: 'start' });
        getMap()?.setCenter([picking.record.lat, picking.record.lon], Math.max(getMap().getZoom(), 18), { duration: 300 });
      }
      document.getElementById('assignmentAdd').onclick = () => begin();
      document.getElementById('assignmentCancel').onclick = cancel;
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && picking) { event.stopImmediatePropagation(); cancel(); } }, true);
      const passwordInput = document.getElementById('assignmentPassword');
      passwordInput.required = false;
      passwordInput.placeholder = 'Районам пароль не нужен';
      document.querySelector('label[for="assignmentPassword"]').textContent = 'Пароль только для префектуры';
      document.getElementById('assignmentLogin').onsubmit = async event => {
        event.preventDefault(); const password = document.getElementById('assignmentPassword');
        const submit = event.currentTarget.querySelector('button'); submit.disabled = true;
        try { await api.login(document.getElementById('assignmentEmail').value.trim(), password.value); password.value = ''; sessionUI(); await refresh(); }
        catch (error) { message('Вход не выполнен: ' + error.message, true); }
        finally { password.value = ''; submit.disabled = false; }
      };
      document.getElementById('assignmentLogout').onclick = () => { if (picking) { picking.saving = false; cancel(); } api.clearSession(); revision++; sessionUI(); refresh(); message('Вы вышли из учётной записи.'); };
      sessionUI();
      if (api.user()) api.request('/api/me').then(() => refresh()).catch(error => { api.clearSession(); sessionUI(); refresh(); message('Войдите повторно: ' + error.message, true); }); else refresh();
      return {
        open(record) { selected = record; renderList(); renderMap(); panel.hidden = false; },
        close() { if (selected) { selected = null; renderMap(); } },
        mapReady() { getMap().events.add('click', event => pick(event.get('coords'))); renderMap(); },
        pick, isPicking: () => Boolean(picking),
        filter(records) { visibleObjects = new Set(records.map(record => record.id)); renderMap(); },
      };
    },
  };
}());
