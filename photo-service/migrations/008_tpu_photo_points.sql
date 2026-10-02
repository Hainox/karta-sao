CREATE TABLE IF NOT EXISTS object_photo_points (
  id uuid PRIMARY KEY,
  dataset_id text NOT NULL CHECK (dataset_id = 'sao_tpu_parking'),
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 180),
  object_type text NOT NULL CHECK (object_type IN ('tpu', 'parking')),
  district text NOT NULL,
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 160),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  created_by text NOT NULL REFERENCES users(id),
  updated_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE INDEX IF NOT EXISTS object_photo_points_object_idx ON object_photo_points(dataset_id, object_key);
CREATE INDEX IF NOT EXISTS object_photo_points_district_idx ON object_photo_points(district);

CREATE TABLE IF NOT EXISTS object_photo_point_photos (
  id uuid PRIMARY KEY,
  point_id uuid NOT NULL REFERENCES object_photo_points(id),
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL CHECK (photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  photo_filename text NOT NULL CHECK (char_length(photo_filename) BETWEEN 1 AND 180),
  photo_size integer NOT NULL CHECK (photo_size BETWEEN 1 AND 5242880),
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS object_photo_point_photos_point_idx ON object_photo_point_photos(point_id);

ALTER TABLE object_photo_points ADD COLUMN IF NOT EXISTS assignment_version integer NOT NULL DEFAULT 1 CHECK (assignment_version > 0);
ALTER TABLE object_photo_point_photos ADD COLUMN IF NOT EXISTS assignment_version integer;
ALTER TABLE object_photo_point_photos ADD COLUMN IF NOT EXISTS assignment_longitude double precision;
ALTER TABLE object_photo_point_photos ADD COLUMN IF NOT EXISTS assignment_latitude double precision;
UPDATE object_photo_point_photos f
SET assignment_version = p.assignment_version,
    assignment_longitude = p.longitude,
    assignment_latitude = p.latitude
FROM object_photo_points p
WHERE f.point_id = p.id AND f.assignment_version IS NULL;
ALTER TABLE object_photo_point_photos ALTER COLUMN assignment_version SET NOT NULL;
ALTER TABLE object_photo_point_photos ALTER COLUMN assignment_longitude SET NOT NULL;
ALTER TABLE object_photo_point_photos ALTER COLUMN assignment_latitude SET NOT NULL;
