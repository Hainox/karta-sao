ALTER TABLE object_photo_points ADD COLUMN IF NOT EXISTS heading double precision CHECK (heading >= 0 AND heading < 360);
