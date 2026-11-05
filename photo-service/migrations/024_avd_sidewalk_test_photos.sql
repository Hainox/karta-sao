-- Фотослоты «Тротуары 2.0» имеют стабильные ID кадров из Excel.
-- Рабочие фото районных тротуаров остаются в своей таблице.
CREATE TABLE IF NOT EXISTS avd_sidewalk_test_photos (
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
CREATE INDEX IF NOT EXISTS avd_sidewalk_test_photos_frame_idx
  ON avd_sidewalk_test_photos(frame_id, uploaded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS avd_sidewalk_test_photos_one_active_idx
  ON avd_sidewalk_test_photos(frame_id) WHERE status IN ('pending', 'accepted');
