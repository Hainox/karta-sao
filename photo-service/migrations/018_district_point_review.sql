ALTER TABLE object_photo_points
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'accepted'
    CHECK (review_status IN ('pending', 'accepted', 'rework')),
  ADD COLUMN IF NOT EXISTS review_comment text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewed_by text REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

CREATE INDEX IF NOT EXISTS object_photo_points_review_queue_idx
  ON object_photo_points(review_status, created_at)
  WHERE dataset_id = 'sao_district_photo_points' AND retired_at IS NULL;
