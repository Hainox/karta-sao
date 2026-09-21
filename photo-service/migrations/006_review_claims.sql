CREATE TABLE IF NOT EXISTS review_claims (
  object_key text PRIMARY KEY REFERENCES objects(object_key) ON DELETE CASCADE,
  owner_key text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS review_claims_expiry_idx ON review_claims (expires_at);
