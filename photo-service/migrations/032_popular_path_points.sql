-- Приоритетные (самые проходные) дорожки и их точки съёмки.
--
-- popular ставится офлайн-рейтингом по подъездам, метро, остановкам и объектам
-- притяжения. Это не отдельная точка: тот же снимок, но в кабинете и на карте
-- его можно отфильтровать и показать первым.
ALTER TABLE pedestrian_path_points
  ADD COLUMN IF NOT EXISTS popular boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS popular_rank integer,
  ADD COLUMN IF NOT EXISTS popular_score double precision;

CREATE INDEX IF NOT EXISTS pedestrian_path_points_popular_idx
  ON pedestrian_path_points (district, popular_rank) WHERE popular;
