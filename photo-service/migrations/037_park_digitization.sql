CREATE TABLE IF NOT EXISTS park_digitization_objects (
  id uuid PRIMARY KEY,
  district text NOT NULL,
  name text NOT NULL,
  asu_ids text[] NOT NULL DEFAULT '{}',
  source_objects jsonb NOT NULL,
  geometry jsonb,
  geometry_source text,
  registry_status text NOT NULL CHECK (registry_status IN ('unverified', 'matched', 'absent_in_source', 'conflict')),
  needs_review boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS park_digitization_points (
  id uuid PRIMARY KEY,
  park_id uuid NOT NULL REFERENCES park_digitization_objects(id),
  frame_id uuid NOT NULL UNIQUE,
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  azimuth double precision NOT NULL CHECK (azimuth >= 0 AND azimuth < 360),
  location_reason text CHECK (char_length(location_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1,
  retired_at timestamptz
);
CREATE INDEX IF NOT EXISTS park_digitization_points_park_idx ON park_digitization_points (park_id) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS park_digitization_photos (
  id uuid PRIMARY KEY,
  frame_id uuid NOT NULL REFERENCES park_digitization_points(frame_id),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL CHECK (photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  photo_filename text NOT NULL,
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text REFERENCES users(id),
  reviewed_at timestamptz,
  review_comment text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS park_digitization_photos_frame_idx ON park_digitization_photos (frame_id, uploaded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS park_digitization_photos_active_idx ON park_digitization_photos (frame_id)
  WHERE status IN ('pending', 'accepted');
