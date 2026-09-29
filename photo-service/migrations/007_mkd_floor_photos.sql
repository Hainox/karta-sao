-- Отдел МКД: отдельная учётка и отдельные фото первых этажей подъездов.
--
-- Фото первых этажей не входят в фотофиксацию: у них нет нормы, приёмки,
-- «На штаб» и сводок. Поэтому они лежат в своей таблице — ни один отчёт
-- основной фотофиксации её не читает, и смешать счётчики нельзя даже ошибкой
-- в фильтре. Повторный запуск миграции безопасен: ограничения снимаются и
-- ставятся заново, таблицы создаются только при отсутствии.

-- Роль «Отдел МКД» работает по всему округу, поэтому района у неё нет.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('district_editor', 'prefecture_admin', 'mkd_editor'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_check;
ALTER TABLE users ADD CONSTRAINT users_check
  CHECK ((role = 'district_editor' AND district IS NOT NULL) OR role IN ('prefecture_admin', 'mkd_editor'));

CREATE TABLE IF NOT EXISTS mkd_floor_photos (
  id text PRIMARY KEY,
  object_key text NOT NULL REFERENCES objects(object_key) ON DELETE RESTRICT,
  -- Подъезд на карте (`injob:N`): фото принадлежит конкретной точке.
  source_id text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  thumbnail_key text,
  original_filename text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  sha256 text NOT NULL,
  performer text NOT NULL,
  comment text NOT NULL DEFAULT '',
  captured_at timestamptz,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  gps_latitude numeric,
  gps_longitude numeric,
  gps_accuracy_m numeric,
  uploaded_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mkd_floor_photos_source_idx ON mkd_floor_photos (source_id, uploaded_at);
CREATE INDEX IF NOT EXISTS mkd_floor_photos_object_idx ON mkd_floor_photos (object_key);

-- Своя таблица ключей повтора: общая ссылается на photos и сюда не подходит.
CREATE TABLE IF NOT EXISTS mkd_idempotency_keys (
  idempotency_key text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  photo_id text NOT NULL REFERENCES mkd_floor_photos(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
