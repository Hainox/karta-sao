-- Решения, пришедшие из Google-таблицы, и их применение в кабинете.
--
-- Таблица хранит решение и историю; возврат применяется к конкретному снимку
-- (photo_id), а не к точке. Так устаревшая строка не отзовёт уже переснятый
-- кадр: UPDATE сработает только если снимок всё ещё accepted.
CREATE TABLE IF NOT EXISTS playground_sheet_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  point_id uuid NOT NULL REFERENCES playground_photo_points(id),
  photo_id uuid REFERENCES playground_photo_slot_photos(id),
  decision text NOT NULL CHECK (decision IN ('accepted_crosscheck', 'rework')),
  reason text,
  comment text,
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  applied_at timestamptz,
  applied_by text REFERENCES users(id),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS playground_sheet_reviews_point_idx
  ON playground_sheet_reviews (point_id, reviewed_at DESC);
