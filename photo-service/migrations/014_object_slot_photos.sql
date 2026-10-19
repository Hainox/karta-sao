-- Слоты фото по заданию на карте ТПУ и парковок: у объекта столько слотов, сколько фото
-- требуется (из каталога, по умолчанию один). Район или АвД загружает фото в слот,
-- префектура принимает или отклоняет его с комментарием. Отклонённое фото освобождает
-- слот, но остаётся в истории: по нему район видит, что исправить.
CREATE TABLE IF NOT EXISTS object_slot_photos (
  id uuid PRIMARY KEY,
  dataset_id text NOT NULL CHECK (dataset_id = 'sao_tpu_parking'),
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 180),
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 50),
  district text NOT NULL,
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL CHECK (photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  photo_filename text NOT NULL CHECK (char_length(photo_filename) BETWEEN 1 AND 180),
  photo_size integer NOT NULL CHECK (photo_size BETWEEN 1 AND 5242880),
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  review_comment text NOT NULL DEFAULT '' CHECK (char_length(review_comment) <= 2000),
  reviewed_by text REFERENCES users(id),
  reviewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS object_slot_photos_object_idx ON object_slot_photos(dataset_id, object_key);
CREATE INDEX IF NOT EXISTS object_slot_photos_district_idx ON object_slot_photos(district);
-- В слоте одновременно лежит не больше одного действующего фото (на проверке или принятого).
CREATE UNIQUE INDEX IF NOT EXISTS object_slot_photos_active_idx
  ON object_slot_photos(dataset_id, object_key, slot) WHERE status IN ('pending', 'accepted');
