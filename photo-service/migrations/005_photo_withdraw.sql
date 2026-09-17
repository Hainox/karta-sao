-- Отзыв ошибочно загруженного фото районом.
--
-- Самый частый вопрос районов — «как удалить фото, которое загрузили по ошибке».
-- Удалять физически может только префектура, поэтому район получает мягкий отзыв:
-- кадр остаётся в базе для разбора, но исчезает из выборок и счётчиков — так же,
-- как отклонённый приёмкой. Повторный запуск миграции безопасен: ограничение
-- сначала снимается, затем ставится заново.
ALTER TABLE photos DROP CONSTRAINT IF EXISTS photos_review_status_check;
ALTER TABLE photos ADD CONSTRAINT photos_review_status_check
  CHECK (review_status IN ('pending_review', 'confirmed', 'rejected', 'withdrawn'));

ALTER TABLE photos ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS withdrawn_by text REFERENCES users(id);

CREATE INDEX IF NOT EXISTS photos_withdrawn_idx ON photos (withdrawn_at) WHERE withdrawn_at IS NOT NULL;
