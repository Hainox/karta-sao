import { mountAvdSidewalks } from './sidewalks.mjs';

const DISTRICTS = {
  'Аэропорт': 'aeroport', 'Беговой': 'begovoy', 'Бескудниковский': 'beskudnikovskiy',
  'Войковский': 'voykovskiy', 'Восточное Дегунино': 'vostochnoe-degunino', 'Головинский': 'golovinskiy',
  'Дмитровский': 'dmitrovskiy', 'Западное Дегунино': 'zapadnoe-degunino', 'Коптево': 'koptevo',
  'Левобережный': 'levoberezhnyy', 'Молжаниновский': 'molzhaninovskiy', 'Савеловский': 'savelovskiy',
  'Сокол': 'sokol', 'Тимирязевский': 'timiryazevskiy', 'Ховрино': 'hovrino', 'Хорошевский': 'horoshevskiy',
};
const AVD = 'АвД САО';
const byId = (id) => document.getElementById(id);
let sidewalkLayer;
let avdSession = false;

function isAvd(user) {
  return user?.role === 'district_editor' && user.district === AVD;
}

async function setupAccount() {
  const api = window.TpuPhotoApi;
  const button = byId('login');
  const status = byId('accountStatus');
  if (!api) {
    status.textContent = 'Вход доступен на опубликованной карте.';
    return;
  }
  let signedIn = false;
  function render() {
    button.textContent = signedIn ? 'Выйти' : 'Войти как АвД САО';
    button.classList.toggle('primary', !signedIn);
    byId('workLink').hidden = !signedIn;
    avdSession = signedIn;
    sidewalkLayer?.setAccess(signedIn);
    status.textContent = signedIn ? 'Вы вошли как АвД САО.' : 'Вход без пароля';
  }
  if (isAvd(api.user())) {
    try {
      const response = await api.request('/api/me');
      signedIn = isAvd((await response.json()).user);
    } catch {
      status.textContent = 'Не удалось проверить вход. Войдите повторно.';
    }
  }
  if (signedIn) render();
  button.disabled = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (signedIn) {
        await api.request('/auth/logout', { method: 'POST' });
        api.clearSession();
        signedIn = false;
      } else {
        signedIn = isAvd(await api.login(AVD, ''));
        if (!signedIn) {
          api.clearSession();
          throw new Error('Учётка АвД САО не найдена.');
        }
      }
      render();
    } catch {
      status.textContent = signedIn ? 'Не удалось выйти. Попробуйте ещё раз.' : 'Не удалось войти как АвД САО. Попробуйте ещё раз.';
    } finally {
      button.disabled = false;
    }
  });
}

function loadYandex() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://api-maps.yandex.ru/v3/?apikey=6b197a0e-9109-4624-9520-954a47c26dda&lang=ru_RU';
    script.onload = () => window.ymaps3 ? resolve(window.ymaps3) : reject(new Error('API карты не загрузился'));
    script.onerror = () => reject(new Error('API карты недоступен'));
    document.head.append(script);
  });
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось загрузить ${url}: HTTP ${response.status}`);
  return response.json();
}

function bounds(features) {
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  function collect(value) {
    if (typeof value[0] === 'number') {
      for (const axis of [0, 1]) {
        min[axis] = Math.min(min[axis], value[axis]);
        max[axis] = Math.max(max[axis], value[axis]);
      }
    } else value.forEach(collect);
  }
  features.forEach(({ geometry }) => collect(geometry.coordinates));
  return [min, max];
}

function showObject(label, district, properties) {
  byId('selectionTitle').textContent = properties.object_type_name || label;
  byId('selectionDetails').textContent = [district, properties.parent_object_name, properties.balance_holder]
    .filter(Boolean).join(' · ');
  byId('selection').hidden = false;
}

async function setupMap() {
  const [ymaps, districtData, manifest] = await Promise.all([
    loadYandex(), readJson('../../districts.geojson'), readJson('../layers/manifest.json'),
  ]);
  await ymaps.ready;
  const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer, YMapFeature, YMapMarker } = ymaps;
  const map = new YMap(byId('map'), {
    location: { bounds: bounds(districtData.features) }, theme: 'light', showScaleInCopyrights: true,
  }, [new YMapDefaultSchemeLayer({}), new YMapDefaultFeaturesLayer({})]);
  sidewalkLayer = mountAvdSidewalks({ map, ymaps, api: window.TpuPhotoApi });
  sidewalkLayer.setAccess(avdSession);
  const status = byId('mapStatus');
  const districtSelect = byId('district');
  const byDistrict = new Map(districtData.features.map((feature) => [feature.properties.district, feature]));
  const focus = (district) => {
    const feature = byDistrict.get(district);
    districtSelect.value = feature ? district : '';
    sidewalkLayer.setDistrict(districtSelect.value);
    map.update({ location: { bounds: bounds(feature ? [feature] : districtData.features), duration: 250 } });
  };
  for (const district of Object.keys(DISTRICTS)) districtSelect.add(new Option(district, district));
  districtSelect.disabled = false;
  districtSelect.addEventListener('change', () => focus(districtSelect.value));
  for (const [id, step] of [['zoomIn', 1], ['zoomOut', -1]]) {
    const button = byId(id);
    button.disabled = false;
    button.addEventListener('click', () => {
      map.update({ location: { zoom: Math.max(3, Math.min(21, map.zoom + step)), duration: 180 } });
    });
  }

  function draw(feature, district, key, config, id) {
    const boundary = key === 'boundary';
    const onClick = boundary ? () => focus(district) : () => showObject(config.label, district, feature.properties || {});
    const style = {
      fill: config.color, fillOpacity: boundary ? 0 : 0.32, interactive: true, cursor: 'pointer',
      stroke: [{ color: config.color, width: boundary ? 2.5 : 1.2, opacity: 0.9 }],
    };
    let child;
    if (feature.geometry.type === 'Point') {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.setAttribute('aria-label', config.label + ' · ' + district);
      marker.style.cssText = 'border-radius:50%;width:12px;height:12px;padding:0;transform:translate(-50%,-50%);border:2px solid white';
      marker.style.background = config.color;
      marker.addEventListener('click', onClick);
      child = new YMapMarker({ coordinates: feature.geometry.coordinates }, marker);
    } else {
      child = new YMapFeature({ id, geometry: feature.geometry, style, onClick });
    }
    map.addChild(child);
    return child;
  }

  const loading = new Set();
  const errors = new Set();
  const formatStatus = () => {
    status.hidden = !loading.size && !errors.size;
    status.textContent = [
      loading.size ? 'Загружаем: ' + [...loading].join(', ') : '',
      errors.size ? 'Не удалось загрузить: ' + [...errors].join(', ') + '. Включите слой повторно.' : '',
    ].filter(Boolean).join(' ');
  };

  for (const [key, config] of Object.entries(manifest.layers)) {
    const label = document.createElement('label');
    label.className = 'layer';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = config.color;
    const title = key === 'boundary' ? 'Границы районов' : config.label;
    label.append(input, swatch, title);
    byId('layers').append(label);
    const children = [];
    let records = key === 'boundary' ? districtData.features.map((feature) => [feature, feature.properties.district]) : null;
    async function toggle() {
      if (!input.checked) {
        for (const child of children.splice(0)) map.removeChild(child);
        return;
      }
      input.disabled = true;
      errors.delete(title);
      loading.add(title);
      formatStatus();
      try {
        if (!records) {
          const groups = await Promise.all(Object.entries(DISTRICTS).map(async ([district, slug]) => {
            if (!manifest.districts[district][key]) return [];
            const data = await readJson(`../layers/${slug}/${key}.geojson`);
            return data.features.filter((feature) => feature.geometry).map((feature) => [feature, district]);
          }));
          records = groups.flat();
        }
        for (const [index, [feature, district]] of records.entries()) {
          if (index && index % 400 === 0) await new Promise(requestAnimationFrame);
          children.push(draw(feature, district, key, config, `${key}-${index}`));
        }
      } catch (error) {
        for (const child of children.splice(0)) map.removeChild(child);
        input.checked = false;
        errors.add(title);
        console.error(error);
      } finally {
        input.disabled = false;
        loading.delete(title);
        formatStatus();
      }
    }
    input.addEventListener('change', toggle);
    if (key === 'boundary') {
      input.checked = true;
      await toggle();
    }
  }
  formatStatus();
}

setupAccount();
setupMap().catch((error) => {
  byId('mapStatus').textContent = 'Карту не удалось загрузить. Обновите страницу.';
  console.error(error);
});
