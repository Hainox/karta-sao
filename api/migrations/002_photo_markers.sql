CREATE TABLE IF NOT EXISTS photo_markers (
  id uuid PRIMARY KEY,
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  photo_bytes bytea,
  photo_mime_type text CHECK (photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  photo_filename text CHECK (photo_filename IS NULL OR char_length(photo_filename) <= 180),
  photo_size integer CHECK (photo_size IS NULL OR photo_size BETWEEN 1 AND 5242880),
  legacy_source_id text UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((photo_bytes IS NULL AND photo_mime_type IS NULL AND photo_filename IS NULL AND photo_size IS NULL)
      OR (photo_bytes IS NOT NULL AND photo_mime_type IS NOT NULL AND photo_filename IS NOT NULL AND photo_size IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS photo_markers_created_at_idx ON photo_markers(created_at DESC);
