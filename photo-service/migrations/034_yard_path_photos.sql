-- Isolated yard-path photo slots; stable ids from the QGIS catalog.
CREATE TABLE IF NOT EXISTS yard_path_slot_photos (
  id uuid PRIMARY KEY,
  frame_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL CHECK (photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  photo_filename text NOT NULL CHECK (char_length(photo_filename) BETWEEN 1 AND 180),
  photo_size integer NOT NULL CHECK (photo_size BETWEEN 1 AND 5242880),
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  review_comment text NOT NULL DEFAULT '' CHECK (char_length(review_comment) <= 2000),
  reviewed_by text REFERENCES users(id),
  reviewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS yard_path_slot_photos_frame_idx
  ON yard_path_slot_photos(frame_id, uploaded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS yard_path_slot_photos_one_active_idx
  ON yard_path_slot_photos(frame_id) WHERE status IN ('pending', 'accepted');

-- Превью кадров пешеходных дорожек для кабинета приёмки.
--
-- Полный кадр весит в среднем 2,7 МБ (медиана 2,9, максимум 5,1). Для решения
-- «принять / вернуть» достаточно 1600 px по длинной стороне — это 250–350 КБ,
-- то есть в 8–10 раз меньше. Превью неизменяемо: оно привязано к photo_id,
-- а id снимка не переиспользуется, поэтому его можно кэшировать в браузере.
CREATE TABLE IF NOT EXISTS yard_path_photo_previews (
  photo_id uuid PRIMARY KEY REFERENCES yard_path_slot_photos(id) ON DELETE CASCADE,
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL DEFAULT 'image/jpeg',
  photo_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
