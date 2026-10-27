-- Подготовка отдельного набора фотофиксации ДП/СП.
-- Не изменяет существующие районные точки, фотографии или их отчёты.
CREATE TABLE IF NOT EXISTS playground_photo_points (
  id uuid PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  source_row integer NOT NULL,
  source_id text NOT NULL,
  district_code text NOT NULL,
  district text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dp','sp')),
  address text NOT NULL DEFAULT '',
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  source_properties jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS playground_photo_points_district_idx ON playground_photo_points(district_code, kind);
CREATE TABLE IF NOT EXISTS playground_photo_slots (
  point_id uuid PRIMARY KEY REFERENCES playground_photo_points(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS playground_photo_slot_photos (
  id uuid PRIMARY KEY,
  point_id uuid NOT NULL REFERENCES playground_photo_slots(point_id),
  status text NOT NULL CHECK (status IN ('pending','accepted','rejected','superseded')),
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL CHECK (photo_mime_type IN ('image/jpeg','image/png','image/webp')),
  photo_filename text NOT NULL CHECK (char_length(photo_filename) BETWEEN 1 AND 180),
  photo_size integer NOT NULL CHECK (photo_size BETWEEN 1 AND 5242880),
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  review_comment text NOT NULL DEFAULT '',
  reviewed_by text REFERENCES users(id),
  reviewed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS playground_photo_one_active_idx
  ON playground_photo_slot_photos(point_id)
  WHERE status IN ('pending','accepted');
