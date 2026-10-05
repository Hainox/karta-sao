-- Возвращает точки съёмки парковок, снятые миграцией 011 (2026-10-03).
-- Восстанавливается только точка, у которой время снятия совпадает с записью 011:
-- точки, позже удалённые префектурой вручную, не возвращаются.
-- Ответственный повторно назначается по балансодержателю (АвД САО — свои парковки).
WITH restored AS (
  UPDATE object_photo_points p
  SET retired_at = NULL,
      updated_at = now(),
      district = CASE WHEN p.object_key IN ('parking:12344846', 'parking:10002419') THEN 'АвД САО' ELSE p.district END
  FROM audit_log a
  WHERE a.action = 'object_photo_point_retired'
    AND a.metadata->>'reason' = 'Parking excluded from photography assignments'
    AND a.metadata->>'id' = p.id::text
    AND p.dataset_id = 'sao_tpu_parking'
    AND p.object_type = 'parking'
    AND p.retired_at IS NOT NULL
    AND p.retired_at = a.created_at
  RETURNING p.id, p.object_key
)
INSERT INTO audit_log (action, object_key, metadata)
SELECT 'object_photo_point_restored', object_key,
       jsonb_build_object('id', id, 'reason', 'Parking returned to digitization')
FROM restored;
