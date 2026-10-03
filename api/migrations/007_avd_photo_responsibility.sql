UPDATE object_photo_points SET district = 'АвД САО', updated_at = now()
WHERE dataset_id = 'sao_tpu_parking' AND object_key IN ('tpu:800905601','tpu:1331614005','tpu:757159046','tpu:314892354','tpu:10002406','tpu:10002414','tpu:667006150','tpu:314903749','tpu:751086786','tpu:666849395','parking:12344846','parking:10002419')
  AND district IS DISTINCT FROM 'АвД САО';
