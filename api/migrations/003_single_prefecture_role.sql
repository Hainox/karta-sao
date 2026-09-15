-- Одна роль приёмки. Отдельная роль reviewer упразднена: приёмка, выгрузки
-- и фото-метки доступны только роли префектуры.
--
-- Миграции применяются на каждом старте API как сырой SQL,
-- поэтому все шаги идемпотентны.

UPDATE users SET role = 'prefecture_admin' WHERE role = 'reviewer';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('district_editor', 'prefecture_admin'));
