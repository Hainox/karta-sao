-- Исправленное префектурой место объекта на карте ТПУ и парковок. Исходные
-- координаты остаются в каталоге (tpu-objects.json и данные страницы карты);
-- здесь только перенос: карта, районы и архив фото парковок берут место отсюда,
-- если оно есть. Удаление строки возвращает объект на исходное место.
CREATE TABLE IF NOT EXISTS tpu_object_positions (
  object_key text PRIMARY KEY CHECK (char_length(object_key) BETWEEN 1 AND 120),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id)
);
