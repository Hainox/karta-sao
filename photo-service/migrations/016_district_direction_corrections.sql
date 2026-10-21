CREATE TABLE IF NOT EXISTS district_direction_corrections (
  fid integer PRIMARY KEY,
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  azimuth double precision NOT NULL CHECK (azimuth >= 0 AND azimuth < 360),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
