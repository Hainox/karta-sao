-- Районные точки съёмки: слот «одно фото на точку» и проверка префектурой.
-- У каждой районной точки один слот: в нём действует фото на проверке или
-- принятое. Отклонённое фото освобождает слот, но остаётся историей с
-- комментарием. Старые фотографии считаются принятыми; если у точки их было
-- несколько, последний снимок остаётся принятым, предыдущие помечаются как
-- заменённые (история без статуса приёмки). Перенос точки и смена направления
-- фото больше не перетирают: наборы sao_tpu_parking сохраняют прежнее
-- поведение «привязки к версии ракурса».
ALTER TABLE object_photo_point_photos
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  ADD COLUMN IF NOT EXISTS review_comment text NOT NULL DEFAULT ''
    CHECK (char_length(review_comment) <= 2000),
  ADD COLUMN IF NOT EXISTS reviewed_by text REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dataset_id text
    CHECK (dataset_id IN ('sao_tpu_parking', 'sao_district_photo_points'));

-- dataset_id копируется в историю, чтобы БД могла сама держать «одно живое
-- фото на районную точку»: объект_photo_points не участвует в индексе ниже.
UPDATE object_photo_point_photos f
SET dataset_id = p.dataset_id
FROM object_photo_points p
WHERE f.point_id = p.id AND f.dataset_id IS NULL;

ALTER TABLE object_photo_point_photos ALTER COLUMN dataset_id SET NOT NULL;

-- Несколько старых снимков у одной районной точки: последняя остаётся
-- принятой, предыдущие уходят в «заменённые», чтобы уникальный индекс ниже
-- прошёл на существующих данных.
-- Миграции перезапускаются при каждой выкладке: запрос обязан проходить и на
-- живых данных, где у точки бывает три и больше снимков (возвраты на
-- доработку). Прежний подзапрос с OFFSET 1 в этом случае падал с «more than
-- one row returned by a subquery». Принятый снимок уходит в заменённые, только
-- если у той же точки есть более поздний принятый: при живом уникальном
-- индексе ниже (не больше одного действующего фото) это ничего не меняет.
UPDATE object_photo_point_photos f
SET status = 'superseded'
WHERE f.dataset_id = 'sao_district_photo_points'
  AND f.status = 'accepted'
  AND EXISTS (
    SELECT 1 FROM object_photo_point_photos newer
    WHERE newer.point_id = f.point_id
      AND newer.dataset_id = 'sao_district_photo_points'
      AND newer.status = 'accepted'
      AND (newer.uploaded_at, newer.id) > (f.uploaded_at, f.id)
  );

-- В слоте районной точки одновременно лежит не больше одного действующего
-- фото (на проверке или принятого). Остаток держит БД, а не приложение.
CREATE UNIQUE INDEX IF NOT EXISTS object_photo_point_photos_active_district_idx
  ON object_photo_point_photos(point_id)
  WHERE dataset_id = 'sao_district_photo_points' AND status IN ('pending', 'accepted');
