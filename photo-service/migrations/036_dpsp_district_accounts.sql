ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('district_editor', 'prefecture_admin', 'mkd_editor', 'dpsp_district_editor'));

ALTER TABLE users DROP CONSTRAINT users_check;
ALTER TABLE users ADD CONSTRAINT users_check
  CHECK ((role IN ('district_editor', 'dpsp_district_editor') AND district IS NOT NULL)
    OR role IN ('prefecture_admin', 'mkd_editor'));
