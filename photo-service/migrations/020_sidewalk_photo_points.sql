-- Точки съёмки тротуаров у МКД (черновая расстановка из
-- projects/sidewalk-photo-points). Отдельная таблица: районные точки,
-- их фото и отчёты не затрагиваются. Префектура переносит точку, меняет
-- направление кадра или удаляет точку; удалённая точка остаётся в таблице
-- с отметкой retired_at, номер point_no больше никому не выдаётся.
CREATE TABLE IF NOT EXISTS sidewalk_photo_points (
  id uuid PRIMARY KEY,
  point_no text NOT NULL UNIQUE CHECK (char_length(point_no) BETWEEN 1 AND 40),
  district text NOT NULL,
  address text NOT NULL DEFAULT '' CHECK (char_length(address) <= 300),
  unom text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  side text NOT NULL DEFAULT '',
  also_covers text NOT NULL DEFAULT '' CHECK (char_length(also_covers) <= 2000),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  heading integer NOT NULL CHECK (heading BETWEEN 0 AND 359),
  status text NOT NULL DEFAULT 'черновик',
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS sidewalk_photo_points_district_idx ON sidewalk_photo_points(district) WHERE retired_at IS NULL;
