-- Фото точек съёмки тротуаров: один слот на точку, как у площадок ДП/СП.
-- Район загружает снимок на проверку, префектура принимает или возвращает
-- с причиной; снимок префектуры сразу принят. Убранный префектурой снимок
-- остаётся историей со статусом superseded. Районные точки и их фото не
-- затрагиваются.
CREATE TABLE IF NOT EXISTS sidewalk_photo_slot_photos (
  id uuid PRIMARY KEY,
  point_id uuid NOT NULL REFERENCES sidewalk_photo_points(id),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
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
CREATE INDEX IF NOT EXISTS sidewalk_photo_slot_photos_point_idx ON sidewalk_photo_slot_photos(point_id);
CREATE UNIQUE INDEX IF NOT EXISTS sidewalk_photo_one_active_idx
  ON sidewalk_photo_slot_photos(point_id)
  WHERE status IN ('pending', 'accepted');
