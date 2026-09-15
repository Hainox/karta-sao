CREATE TABLE IF NOT EXISTS import_runs (
  id bigserial PRIMARY KEY,
  source_version text NOT NULL,
  source_date date,
  dataset_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_rows jsonb NOT NULL DEFAULT '{}'::jsonb,
  report_objects jsonb NOT NULL DEFAULT '{}'::jsonb,
  unassigned_count integer NOT NULL DEFAULT 0,
  unassigned_objects jsonb NOT NULL DEFAULT '[]'::jsonb,
  mode text NOT NULL CHECK (mode IN ('dry-run', 'apply')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_runs_created_idx ON import_runs (created_at DESC);
