-- Превью 320 px для таблицы приёмки и отзываемые ссылки на них.
--
-- Google Sheets =IMAGE() не умеет авторизацию, поэтому фото отдаётся по
-- неугадываемому токену: таблица получает ссылку, служба — возможность отозвать
-- её (revoked_at), не меняя остальные строки. Оригинал остаётся закрытым.
CREATE TABLE IF NOT EXISTS playground_photo_thumbs (
  photo_id uuid PRIMARY KEY REFERENCES playground_photo_slot_photos(id) ON DELETE CASCADE,
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL DEFAULT 'image/jpeg',
  photo_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS photo_public_tokens (
  token text PRIMARY KEY,
  photo_id uuid NOT NULL REFERENCES playground_photo_slot_photos(id) ON DELETE CASCADE,
  point_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS photo_public_tokens_photo_idx
  ON photo_public_tokens (photo_id);
