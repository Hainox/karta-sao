CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('district_editor', 'reviewer', 'prefecture_admin')),
  district text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submissions (
  id uuid PRIMARY KEY,
  district text NOT NULL,
  author text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  original_filename text NOT NULL,
  payload_sha256 text NOT NULL,
  change_set jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected')) DEFAULT 'submitted',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  review_comment text
);

CREATE INDEX IF NOT EXISTS submissions_status_idx ON submissions(status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS submissions_district_idx ON submissions(district, submitted_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  submission_id uuid REFERENCES submissions(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_submission_idx ON audit_events(submission_id, created_at DESC);
