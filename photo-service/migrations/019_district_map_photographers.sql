-- Dedicated district map photographer accounts. Existing rows and points are unchanged.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('district_editor', 'prefecture_admin', 'mkd_editor', 'district_photographer'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_check;
ALTER TABLE users ADD CONSTRAINT users_check
  CHECK ((role IN ('district_editor', 'district_photographer') AND district IS NOT NULL)
    OR role IN ('prefecture_admin', 'mkd_editor'));
