-- Районный набор точек съёмки («эталонные фото»): расширяем ограничения,
-- чтобы в object_photo_points можно было хранить точки набора sao_district_photo_points
-- с типом объекта district. Существующие строки не затрагиваются.
ALTER TABLE object_photo_points DROP CONSTRAINT object_photo_points_dataset_id_check;
ALTER TABLE object_photo_points ADD CONSTRAINT object_photo_points_dataset_id_check
  CHECK (dataset_id IN ('sao_tpu_parking', 'sao_district_photo_points'));

ALTER TABLE object_photo_points DROP CONSTRAINT object_photo_points_object_type_check;
ALTER TABLE object_photo_points ADD CONSTRAINT object_photo_points_object_type_check
  CHECK (object_type IN ('tpu', 'parking', 'district'));
