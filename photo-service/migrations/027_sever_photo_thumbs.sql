-- Снимки площадок из выгрузки «Север ЖКХ» для колонки «Фото СЖКХ».
--
-- Один снимок на объект (последняя задача, первый кадр), сжатый до 320 px.
-- Отдаётся по неугадываемому токену, как и наши превью: Google Sheets =IMAGE()
-- не умеет авторизацию, а оригиналы остаются в выгрузке оператора.
CREATE TABLE IF NOT EXISTS sever_photo_thumbs (
  object_id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  photo_bytes bytea NOT NULL,
  source_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS sever_photo_thumbs_token_idx
  ON sever_photo_thumbs (token);
