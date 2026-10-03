WITH removed AS (
UPDATE object_photo_points SET retired_at = now(), updated_at = now()
WHERE dataset_id = 'sao_tpu_parking' AND object_type = 'parking' AND retired_at IS NULL
RETURNING id, object_key
)
INSERT INTO audit_log (action, object_key, metadata)
SELECT 'object_photo_point_retired', object_key,
       jsonb_build_object('id', id, 'reason', 'Parking excluded from photography assignments')
FROM removed;
