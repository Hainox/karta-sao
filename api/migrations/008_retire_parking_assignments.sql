UPDATE object_photo_points SET retired_at = now(), updated_at = now()
WHERE dataset_id = 'sao_tpu_parking' AND object_type = 'parking' AND retired_at IS NULL;
