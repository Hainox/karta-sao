-- Тротуары: выгрузка в отдельную Google-таблицу и возврат решений из неё.
--
-- Ссылки на маленькие превью: =IMAGE() в Google Sheets не умеет заголовок
-- Authorization, поэтому ссылка сама является пропуском. Токен неугадываемый,
-- отзывается через revoked_at, оригинал кадра остаётся закрытым. Один токен на
-- снимок: повторная синхронизация не меняет URL, поэтому таблица не
-- перезагружает картинки и кэш Google остаётся валидным.
--
-- Наборов два: «odh» — кадры фотослотов ОДХ (avd_sidewalk_test_photos),
-- «yards» — точки съёмки тротуаров у МДК (sidewalk_photo_slot_photos). Снимки
-- лежат в разных таблицах, поэтому photo_id хранится без FK: связь проверяется
-- при выдаче токена и повторно при каждом чтении превью.
CREATE TABLE IF NOT EXISTS sidewalk_sheet_tokens (
  token text PRIMARY KEY CHECK (token ~ '^[0-9a-f]{32}$'),
  set_name text NOT NULL CHECK (set_name IN ('odh', 'yards')),
  photo_id uuid NOT NULL,
  -- Для «odh» — id фотослота (frame_id), для «yards» — id точки (point_id).
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (set_name, photo_id)
);

CREATE INDEX IF NOT EXISTS sidewalk_sheet_tokens_photo_idx
  ON sidewalk_sheet_tokens (photo_id);

-- Превью 320 px, как у площадок ДП/СП: в таблице достаточно узнать кадр,
-- оригинал открывается в кабинете.
CREATE TABLE IF NOT EXISTS sidewalk_sheet_thumbs (
  photo_id uuid PRIMARY KEY,
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL DEFAULT 'image/jpeg',
  photo_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Журнал решений и их применения. client_id детерминирован в таблице
-- (набор + точка/слот + снимок + решение), поэтому повторная отправка того же
-- решения возвращает результат первого применения и ничего не меняет.
-- Результат пишется и для ошибки: строка с устаревшим снимком не будет
-- отправляться каждые 10 минут, а человек увидит причину.
CREATE TABLE IF NOT EXISTS sidewalk_sheet_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE CHECK (char_length(client_id) BETWEEN 1 AND 80),
  set_name text NOT NULL CHECK (set_name IN ('odh', 'yards')),
  -- Для «odh» — id фотослота, для «yards» — id точки: типы разные, поэтому text.
  point_id text NOT NULL CHECK (char_length(point_id) BETWEEN 1 AND 80),
  photo_id uuid,
  decision text NOT NULL CHECK (decision IN ('verified', 'rework')),
  reason text,
  comment text,
  reviewed_by text NOT NULL CHECK (char_length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  error text,
  applied_at timestamptz,
  applied_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sidewalk_sheet_reviews_slot_idx
  ON sidewalk_sheet_reviews (set_name, point_id, reviewed_at DESC);
