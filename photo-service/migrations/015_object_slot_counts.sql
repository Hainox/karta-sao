-- Изменения числа слотов префектурой; исходный каталог и фотографии сохраняются.
CREATE TABLE IF NOT EXISTS object_slot_counts (
  dataset_id text NOT NULL CHECK (dataset_id = 'sao_tpu_parking'),
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 180),
  required integer NOT NULL CHECK (required BETWEEN 1 AND 50),
  updated_by text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, object_key)
);
