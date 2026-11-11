-- Google-таблица проверки пешеходных дорожек.
--
-- Таблица получает одну строку на точку съёмки, включая точки без фото:
-- «нет фото» — тоже состояние проверки. Превью отдаётся по неугадываемому
-- токену: =IMAGE() в Google Sheets не умеет Authorization. Токен один на
-- снимок и переживает возврат, чтобы таблица не перезагружала картинку.
--
-- Решения таблицы адресуются парой «точка + photo_id». Строка, устаревшая
-- после пересъёмки, не трогает новый кадр: сервер отвечает photo_not_pending
-- или photo_not_found, а журнал сохраняет результат.
CREATE TABLE IF NOT EXISTS pedestrian_path_sheet_tokens (
  token text PRIMARY KEY CHECK (token ~ '^[0-9a-f]{32}$'),
  photo_id uuid NOT NULL UNIQUE,
  point_id uuid NOT NULL REFERENCES pedestrian_path_points(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS pedestrian_path_sheet_tokens_point_idx
  ON pedestrian_path_sheet_tokens (point_id);

-- Превью 320 px, как у площадок и тротуаров: в таблице достаточно узнать кадр,
-- оригинал открывается в кабинете.
CREATE TABLE IF NOT EXISTS pedestrian_path_sheet_thumbs (
  photo_id uuid PRIMARY KEY REFERENCES pedestrian_path_photos(id),
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL DEFAULT 'image/jpeg',
  photo_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Журнал решений таблицы. client_id детерминирован в таблице, поэтому
-- повторная отправка того же решения возвращает результат первого применения.
CREATE TABLE IF NOT EXISTS pedestrian_path_sheet_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE CHECK (char_length(client_id) BETWEEN 1 AND 80),
  point_id uuid NOT NULL REFERENCES pedestrian_path_points(id),
  photo_id uuid NOT NULL REFERENCES pedestrian_path_photos(id),
  decision text NOT NULL CHECK (decision IN ('accepted', 'verified', 'rework')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 2000),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  reviewed_by text NOT NULL DEFAULT 'sheet' CHECK (char_length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  applied boolean NOT NULL DEFAULT false,
  applied_at timestamptz,
  applied_by text REFERENCES users(id),
  error text CHECK (error IS NULL OR char_length(error) <= 200)
);

CREATE INDEX IF NOT EXISTS pedestrian_path_sheet_reviews_point_idx
  ON pedestrian_path_sheet_reviews (point_id, reviewed_at DESC);
