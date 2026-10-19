(function () {
  'use strict';
  // Слоты фото по заданию в карточке объекта карты ТПУ и парковок.
  // Слотов столько, сколько фото требуется («Фото по заданию»; без числа — один).
  // Район или АвД загружает фото в слоты своих объектов, префектура принимает фото
  // или отклоняет с комментарием: слот освобождается, комментарий виден району.
  const STATUS = {
    empty: { label: 'Нет фото', color: '#c66b42' },
    progress: { label: 'В работе', color: '#d99a00' },
    review: { label: 'На проверке', color: '#2a6fdb' },
    rework: { label: 'На доработке', color: '#d7193f' },
    closed: { label: 'Закрыта', color: '#0c7a5a' },
  };
  const endpoint = '/api/object-photo-points/slots';

  window.SaoPhotoSlots = {
    STATUS,
    mount({ notify, onSummary }) {
      const panel = document.getElementById('slotPanel');
      const api = window.TpuPhotoApi || window.ODHApi;
      let record = null;
      let revision = 0;
      let urls = [];
      let summary = new Map();
      const user = () => api.user();
      const clearUrls = () => { urls.forEach(URL.revokeObjectURL); urls = []; };
      const required = (r) => { const n = Number(r?.properties?.['Фото по заданию']); return Number.isInteger(n) && n > 0 ? n : 1; };
      const canUpload = (r) => { const u = user(); return !!u && (u.role === 'prefecture_admin' || (u.role === 'district_editor' && u.district === r.group)); };
      const isPrefecture = () => user()?.role === 'prefecture_admin';
      const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
      const button = (label, action, className = 'secondary-btn') => { const b = el('button', className, label); b.type = 'button'; b.onclick = action; return b; };

      async function json(path, options) {
        const response = await api.request(endpoint + path, options);
        return response.json();
      }

      async function loadSummary() {
        try {
          const data = await json('/public');
          summary = new Map((data.objects || []).map((o) => [o.object_key, o]));
          onSummary?.(summary);
          updateLine();
        } catch (_) { /* сервер недоступен — карта работает без статусов */ }
      }

      // Строка «статус · принято X из N» в карточке по открытой сводке.
      function updateLine() {
        const line = panel.querySelector('.slot-summary');
        const known = record && summary.get(record.id);
        if (line && known) line.replaceChildren(chip(known.status), document.createTextNode(` принято ${known.accepted} из ${known.required}`));
      }

      function chip(status) {
        const info = STATUS[status] || STATUS.empty;
        const node = el('span', 'slot-chip', info.label);
        node.style.background = info.color;
        return node;
      }

      async function photoLink(photo) {
        const response = await api.request(endpoint + '/photos/' + photo.id);
        const url = URL.createObjectURL(await response.blob()); urls.push(url);
        const link = el('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener';
        const image = el('img'); image.src = url; image.alt = 'Фото слота'; image.loading = 'lazy';
        link.append(image);
        return link;
      }

      async function review(photo, decision) {
        let comment = '';
        if (decision === 'rejected') {
          comment = (prompt('Что не так и что исправить? Комментарий увидит район.') || '').trim();
          if (!comment) return;
        }
        try {
          await json('/photos/' + photo.id + '/review', { method: 'POST', body: JSON.stringify({ decision, comment }) });
          notify(decision === 'accepted' ? 'Фото принято.' : 'Фото отклонено, слот отправлен на доработку.');
          await refresh();
        } catch (error) { notify(error.message, true); }
      }

      function uploader(slot) {
        const label = el('label', 'slot-upload', 'Загрузить фото');
        const input = el('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.setAttribute('capture', 'environment');
        input.onchange = async () => {
          const file = input.files[0];
          if (!file) return;
          input.disabled = true; label.firstChild.textContent = 'Отправляем…';
          try {
            await json('/objects/' + encodeURIComponent(record.id) + '/' + slot + '/photo', { method: 'PUT', headers: { 'Content-Type': file.type, 'X-Photo-Filename': encodeURIComponent(file.name) }, body: file });
            notify('Фото загружено в слот ' + slot + ' и ждёт проверки.');
            await refresh();
          } catch (error) { notify('Не удалось загрузить фото: ' + error.message, true); input.disabled = false; label.firstChild.textContent = 'Загрузить фото'; }
        };
        label.append(input);
        return label;
      }

      async function render(version) {
        clearUrls(); panel.replaceChildren();
        if (!record) return;
        const need = required(record);
        const head = el('div', 'section-title', 'Фото по заданию');
        panel.append(head);
        const known = summary.get(record.id);
        const line = el('div', 'slot-summary');
        line.append(chip(known?.status || 'empty'), document.createTextNode(` принято ${known?.accepted || 0} из ${need}`));
        panel.append(line);
        if (!user()) {
          panel.append(el('p', 'slot-hint', 'Чтобы загрузить фото, войдите учётной записью района или АвД САО. Слотов: ' + need + '.'));
          return;
        }
        let state;
        try { state = await json('/objects/' + encodeURIComponent(record.id)); }
        catch (error) { if (version === revision) panel.append(el('p', 'slot-hint', 'Слоты недоступны: ' + error.message)); return; }
        if (version !== revision) return;
        line.replaceChildren(chip(state.status), document.createTextNode(` принято ${state.accepted} из ${state.required}`));
        const grid = el('div', 'slot-grid');
        panel.append(grid);
        for (const slot of state.slots) {
          const card = el('div', 'slot-card');
          const title = el('div', 'slot-title'); title.append(el('strong', '', 'Слот ' + slot.slot));
          card.append(title);
          if (slot.photo) {
            const accepted = slot.photo.status === 'accepted';
            title.append(chip(accepted ? 'closed' : 'review'));
            title.lastChild.textContent = accepted ? 'Принято' : 'На проверке';
            try { const link = await photoLink(slot.photo); if (version !== revision) return; card.append(link); }
            catch (_) { card.append(el('small', '', 'Фото не открылось')); }
            if (isPrefecture()) {
              const actions = el('div', 'slot-actions');
              if (!accepted) actions.append(button('Принять', () => review(slot.photo, 'accepted'), 'save-btn'));
              actions.append(button('Отклонить', () => review(slot.photo, 'rejected')));
              card.append(actions);
            }
          } else {
            if (slot.rejected) {
              title.append(chip('rework'));
              card.append(el('p', 'slot-comment', 'Что исправить: ' + slot.rejected.review_comment));
            } else {
              title.append(el('span', 'slot-empty', 'Свободен'));
            }
            if (canUpload(record)) card.append(uploader(slot.slot));
          }
          grid.append(card);
        }
      }

      async function refresh() {
        const version = ++revision;
        await render(version);
        await loadSummary();
      }

      loadSummary();
      return {
        open(next) { record = next; const version = ++revision; render(version); },
        close() { record = null; revision += 1; clearUrls(); panel.replaceChildren(); },
        refresh() { if (record) refresh(); else loadSummary(); },
        status(id) { return summary.get(id)?.status || null; },
      };
    },
  };
}());
