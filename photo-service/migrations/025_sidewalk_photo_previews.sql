-- Превью кадров тротуаров ОДХ для кабинета приёмки.
--
-- Полный кадр весит в среднем 2,7 МБ (медиана 2,9, максимум 5,1). Для решения
-- «принять / вернуть» достаточно 1600 px по длинной стороне — это 250–350 КБ,
-- то есть в 8–10 раз меньше. Превью неизменяемо: оно привязано к photo_id,
-- а id снимка не переиспользуется, поэтому его можно кэшировать в браузере.
CREATE TABLE IF NOT EXISTS avd_sidewalk_test_photo_previews (
  photo_id uuid PRIMARY KEY REFERENCES avd_sidewalk_test_photos(id) ON DELETE CASCADE,
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL DEFAULT 'image/jpeg',
  photo_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
