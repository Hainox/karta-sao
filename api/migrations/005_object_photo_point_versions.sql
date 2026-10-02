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
