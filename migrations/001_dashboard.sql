CREATE SCHEMA IF NOT EXISTS fullbeam_dashboard;

CREATE TABLE IF NOT EXISTS fullbeam_dashboard.schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fullbeam_dashboard.records (
  repository text NOT NULL,
  record_key text NOT NULL,
  value jsonb NOT NULL,
  value_sha256 text NOT NULL CHECK (value_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository, record_key)
);

INSERT INTO fullbeam_dashboard.schema_migrations(version)
VALUES (1) ON CONFLICT (version) DO NOTHING;
