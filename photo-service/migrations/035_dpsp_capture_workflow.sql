-- Новый цикл фотофиксации ДП/СП: отдельно от ранее принятых фотографий.
CREATE TABLE IF NOT EXISTS dpsp_capture_workflow (
  point_id uuid PRIMARY KEY REFERENCES playground_photo_points(id),
  state text NOT NULL CHECK (state IN ('submitted','accepted','rework')),
  submitted_by text NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text REFERENCES users(id),
  reviewed_at timestamptz,
  review_comment text NOT NULL DEFAULT '' CHECK (char_length(review_comment) <= 2000)
);
CREATE TABLE IF NOT EXISTS dpsp_capture_photos (
  id uuid PRIMARY KEY,
  point_id uuid NOT NULL REFERENCES playground_photo_points(id),
  status text NOT NULL CHECK (status IN ('active','superseded')),
  photo_bytes bytea NOT NULL,
  photo_mime_type text NOT NULL CHECK (photo_mime_type IN ('image/jpeg','image/png','image/webp')),
  photo_filename text NOT NULL CHECK (char_length(photo_filename) BETWEEN 1 AND 180),
  photo_size integer NOT NULL CHECK (photo_size BETWEEN 1 AND 5242880),
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dpsp_capture_photos_point_idx ON dpsp_capture_photos(point_id,uploaded_at) WHERE status='active';
CREATE INDEX IF NOT EXISTS dpsp_capture_workflow_state_idx ON dpsp_capture_workflow(state);

-- Блокируем изменения состава МАФ и их фото после отправки. Тот же замок на
-- родителе используется при смене этапа; старые вкладки не обходят правило.
CREATE OR REPLACE FUNCTION dpsp_capture_guard_maf() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid; stage text;
BEGIN
  IF TG_TABLE_NAME='dpsp_maf_items' THEN
    IF TG_OP='DELETE' THEN parent_id:=OLD.point_id; ELSE parent_id:=NEW.point_id; END IF;
  ELSE
    IF TG_OP='DELETE' THEN
      SELECT point_id INTO parent_id FROM dpsp_maf_items WHERE id=OLD.item_id;
    ELSE
      SELECT point_id INTO parent_id FROM dpsp_maf_items WHERE id=NEW.item_id;
    END IF;
  END IF;
  PERFORM 1 FROM playground_photo_points WHERE id=parent_id FOR UPDATE;
  SELECT state INTO stage FROM dpsp_capture_workflow WHERE point_id=parent_id;
  IF stage IN ('submitted','accepted') THEN
    RAISE EXCEPTION 'Площадка передана на приёмку; изменения закрыты.' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='dpsp_capture_guard_items' AND tgrelid='dpsp_maf_items'::regclass) THEN
   CREATE TRIGGER dpsp_capture_guard_items BEFORE INSERT OR UPDATE OR DELETE ON dpsp_maf_items
     FOR EACH ROW EXECUTE FUNCTION dpsp_capture_guard_maf();
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='dpsp_capture_guard_photos' AND tgrelid='dpsp_maf_photos'::regclass) THEN
   CREATE TRIGGER dpsp_capture_guard_photos BEFORE INSERT OR UPDATE OR DELETE ON dpsp_maf_photos
     FOR EACH ROW EXECUTE FUNCTION dpsp_capture_guard_maf();
 END IF;
END $$;
