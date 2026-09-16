-- Точка источника, к которой относится фиксация.
-- Район снимает конкретную точку на карте, поэтому единица учёта — точка,
-- а не уникальный объект: у одного перехода точек может быть несколько десятков.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS source_id text;
CREATE INDEX IF NOT EXISTS photos_source_id_idx ON photos (source_id);
