CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('district_editor', 'prefecture_admin')),
  district text,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'district_editor' AND district IS NOT NULL) OR role = 'prefecture_admin')
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS objects (
  object_key text PRIMARY KEY,
  dataset_id text NOT NULL,
  object_type text NOT NULL CHECK (object_type IN ('stop', 'pp', 'entrance')),
  report_key text NOT NULL,
  source_ids text[] NOT NULL,
  district text,
  label text NOT NULL,
  reference_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, object_type, report_key)
);

CREATE INDEX IF NOT EXISTS objects_dataset_source_idx ON objects (dataset_id);
CREATE INDEX IF NOT EXISTS objects_district_type_idx ON objects (district, object_type);

CREATE TABLE IF NOT EXISTS photos (
  id text PRIMARY KEY,
  object_key text NOT NULL REFERENCES objects(object_key) ON DELETE RESTRICT,
  storage_key text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  sha256 text NOT NULL,
  performer text NOT NULL,
  comment text NOT NULL DEFAULT '',
  captured_at timestamptz,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  gps_latitude numeric,
  gps_longitude numeric,
  gps_accuracy_m numeric,
  distance_m numeric,
  geo_status text NOT NULL CHECK (geo_status IN ('within_radius', 'within_tolerance', 'risk', 'review')),
  review_status text NOT NULL DEFAULT 'pending_review' CHECK (review_status IN ('pending_review', 'confirmed', 'rejected')),
  review_reason text,
  is_reference boolean NOT NULL DEFAULT false,
  uploaded_by text NOT NULL REFERENCES users(id),
  reviewed_by text REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS photos_object_idx ON photos (object_key, review_status);
CREATE INDEX IF NOT EXISTS photos_geo_idx ON photos (geo_status);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  photo_id text NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id text REFERENCES users(id),
  action text NOT NULL,
  object_key text,
  photo_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
