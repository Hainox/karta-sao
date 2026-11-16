-- Оцифровка МАФ на детских и спортивных площадках (кабинет префектуры).
--
-- Родительский объект — существующая точка площадки playground_photo_points
-- (ДП/СП из АСУ ОДС, импортируется scripts/import-playground-photo-points.js).
-- Дочерний объект — МАФ, найденный префектурой при оцифровке: тип, количество,
-- состояние, комментарий и один активный снимок.
-- Модуль не меняет существующие таблицы фотофиксации и её отчёты.

CREATE TABLE IF NOT EXISTS dpsp_maf_types (
  code text PRIMARY KEY,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  -- null = тип подходит и ДП, и СП (например, «Прочее»)
  kind text CHECK (kind IN ('dp','sp')),
  sort integer NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS dpsp_maf_items (
  id uuid PRIMARY KEY,
  point_id uuid NOT NULL REFERENCES playground_photo_points(id),
  type_code text NOT NULL REFERENCES dpsp_maf_types(code),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999),
  condition text NOT NULL DEFAULT 'ok' CHECK (condition IN ('ok','repair','broken')),
  comment text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 2000),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Мягкое удаление: история оцифровки сохраняется для сверки.
  retired_at timestamptz
);
CREATE INDEX IF NOT EXISTS dpsp_maf_items_point_idx ON dpsp_maf_items(point_id);
CREATE INDEX IF NOT EXISTS dpsp_maf_items_active_idx ON dpsp_maf_items(point_id) WHERE retired_at IS NULL;

-- Отметка «площадка оцифрована» — в том числе для площадок, где МАФ не нашли.
CREATE TABLE IF NOT EXISTS dpsp_site_checks (
  point_id uuid PRIMARY KEY REFERENCES playground_photo_points(id),
  checked_by text NOT NULL REFERENCES users(id),
  checked_at timestamptz NOT NULL DEFAULT now(),
  comment text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 2000)
);

CREATE TABLE IF NOT EXISTS dpsp_maf_photos (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES dpsp_maf_items(id),
  status text NOT NULL CHECK (status IN ('active','superseded')),
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL CHECK (photo_mime_type IN ('image/jpeg','image/png','image/webp')),
  photo_filename text NOT NULL CHECK (char_length(photo_filename) BETWEEN 1 AND 180),
  photo_size integer NOT NULL CHECK (photo_size BETWEEN 1 AND 5242880),
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
-- Один активный снимок на МАФ; замена переводит старый в «superseded».
CREATE UNIQUE INDEX IF NOT EXISTS dpsp_maf_one_active_photo_idx
  ON dpsp_maf_photos(item_id) WHERE status = 'active';

-- Токен — единственный пропуск к превью: Google Sheets =IMAGE() не умеет
-- авторизацию, поэтому ссылка сама является пропуском. Токен отзывается
-- (revoked_at) при замене снимка или удалении МАФ.
CREATE TABLE IF NOT EXISTS dpsp_maf_photo_tokens (
  token text PRIMARY KEY,
  photo_id uuid NOT NULL REFERENCES dpsp_maf_photos(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS dpsp_maf_photo_tokens_photo_idx ON dpsp_maf_photo_tokens(photo_id);
CREATE INDEX IF NOT EXISTS dpsp_maf_photo_tokens_item_idx ON dpsp_maf_photo_tokens(item_id);

-- Ленивое превью 320 px: готовится при первом запросе и кэшируется.
CREATE TABLE IF NOT EXISTS dpsp_maf_thumbs (
  photo_id uuid PRIMARY KEY REFERENCES dpsp_maf_photos(id) ON DELETE CASCADE,
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL DEFAULT 'image/jpeg',
  photo_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Стартовый справочник МАФ; пополняется миграциями или вручную (code, label).
INSERT INTO dpsp_maf_types (code, label, kind, sort) VALUES
  ('swings', 'Качели', 'dp', 10),
  ('swing_boats', 'Качели-лодочки', 'dp', 20),
  ('balance', 'Качалки-балансиры', 'dp', 30),
  ('spring_rocker', 'Пружинные качалки', 'dp', 40),
  ('slides', 'Горки', 'dp', 50),
  ('carousels', 'Карусели', 'dp', 60),
  ('sandboxes', 'Песочницы', 'dp', 70),
  ('play_houses', 'Игровые домики', 'dp', 80),
  ('mazes', 'Лабиринты', 'dp', 90),
  ('climbing_frames', 'Рукоходы', 'dp', 100),
  ('wall_bars', 'Шведские стенки', 'dp', 110),
  ('trampolines', 'Батуты', 'dp', 120),
  ('play_complexes', 'Игровые комплексы', 'dp', 130),
  ('crossbars', 'Турники', 'sp', 10),
  ('parallel_bars', 'Брусья', 'sp', 20),
  ('basketball_hoops', 'Баскетбольные кольца', 'sp', 30),
  ('football_goals', 'Футбольные ворота', 'sp', 40),
  ('table_tennis', 'Столы настольного тенниса', 'sp', 50),
  ('street_trainers', 'Уличные тренажёры', 'sp', 60),
  ('workout_complexes', 'Воркаут-комплексы', 'sp', 70),
  ('volleyball_posts', 'Волейбольные стойки', 'sp', 80),
  ('other', 'Прочее', NULL, 900)
ON CONFLICT (code) DO NOTHING;
