-- Оцифровка пешеходных дорожек АСУ ОДС.
--
-- Одна дорожка — это полигон из реестра. Короткие снимаются одной точкой,
-- длинные — несколькими точками вдоль трассы (шаг около 70 м). Поэтому
-- единица учёта — не дорожка, а точка съёмки pedestrian_path_points: у неё
-- один фотослот, как у площадок ДП/СП. path_id остаётся ссылкой на объект
-- АСУ ОДС, чтобы в карточке и на карте открыть исходный полигон.
--
-- point_no назначается один раз и не переезжает: он собран из path_id и
-- порядкового номера вдоль трассы (ПД-<path_id>-<nn>). Повторный импорт
-- обновляет координаты и адрес, но не меняет идентификатор точки.
CREATE TABLE IF NOT EXISTS pedestrian_path_points (
  id uuid PRIMARY KEY,
  point_no text NOT NULL UNIQUE CHECK (char_length(point_no) BETWEEN 1 AND 40),
  path_id bigint NOT NULL,
  ogh_id bigint,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  district text NOT NULL,
  address text NOT NULL DEFAULT '' CHECK (char_length(address) <= 300),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  route_m double precision CHECK (route_m IS NULL OR route_m >= 0),
  area double precision CHECK (area IS NULL OR area >= 0),
  coating text NOT NULL DEFAULT '' CHECK (char_length(coating) <= 120),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path_id, ordinal)
);

CREATE INDEX IF NOT EXISTS pedestrian_path_points_district_idx
  ON pedestrian_path_points (district) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS pedestrian_path_points_path_idx
  ON pedestrian_path_points (path_id);

-- Фото точки: активным считается одно pending или accepted. Возврат переводит
-- accepted в rejected и освобождает слот — район (здесь префектура) снимает
-- заново. История rejected остаётся, чтобы показать причину возврата.
CREATE TABLE IF NOT EXISTS pedestrian_path_photos (
  id uuid PRIMARY KEY,
  point_id uuid NOT NULL REFERENCES pedestrian_path_points(id),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL CHECK (photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  photo_filename text NOT NULL CHECK (char_length(photo_filename) BETWEEN 1 AND 180),
  photo_size integer NOT NULL CHECK (photo_size BETWEEN 1 AND 5242880),
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  review_comment text NOT NULL DEFAULT '' CHECK (char_length(review_comment) <= 2000),
  reviewed_by text REFERENCES users(id),
  reviewed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS pedestrian_path_photos_one_active_idx
  ON pedestrian_path_photos (point_id)
  WHERE status IN ('pending', 'accepted');
CREATE INDEX IF NOT EXISTS pedestrian_path_photos_point_idx
  ON pedestrian_path_photos (point_id, uploaded_at DESC);
