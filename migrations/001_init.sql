-- Voter Desk schema. The server is the source of truth for IDs, timestamps and every business rule;
-- constraints here back up the most important ones (unique mobile, unique voter ID, one successful
-- payment per voter) so they hold even under concurrent requests.
-- Roles: Super Admin -> Corporator (C-n) -> BLO (C-n-BLOm). Payments are cash in hand.

-- Natural ordering for text sorts ("BL-2" before "BL-10"), matching localeCompare(..., { numeric: true }).
CREATE COLLATION IF NOT EXISTS natural_sort (provider = icu, locale = 'en-u-kn-true');

-- Gapless sequential numbers for IDs (C-n, VR-000001, TXN-000001, AUD-000001, ...). BLO numbers live on the Corporator row.
CREATE TABLE counters (
  name  text PRIMARY KEY,
  value bigint NOT NULL DEFAULT 0
);
INSERT INTO counters (name) VALUES ('corporator'), ('voter'), ('txn'), ('audit'), ('ward'), ('booth'), ('settings');

CREATE TABLE admins (
  id            text PRIMARY KEY,
  full_name     text NOT NULL,
  mobile        text NOT NULL UNIQUE,
  role          text NOT NULL CHECK (role IN ('SUPER_ADMIN', 'CORPORATOR', 'BLO')),
  -- A BLO belongs to exactly one Corporator for life (its ID embeds the Corporator's).
  corporator_id text REFERENCES admins (id),
  -- Where a Corporator is based (free text); empty for other roles.
  location      text NOT NULL DEFAULT '',
  -- Last BLO number issued by this Corporator (C-1-BLO1, C-1-BLO2, ...).
  blo_counter   integer NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('Active', 'Inactive')),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'BLO') = (corporator_id IS NOT NULL))
);
CREATE INDEX admins_corporator_idx ON admins (corporator_id) WHERE corporator_id IS NOT NULL;

CREATE TABLE wards (
  id     text PRIMARY KEY,
  number integer NOT NULL UNIQUE CHECK (number > 0),
  name   text NOT NULL
);

CREATE TABLE booths (
  id      text PRIMARY KEY,
  ward_id text NOT NULL REFERENCES wards (id),
  number  integer NOT NULL CHECK (number > 0),
  name    text NOT NULL,
  UNIQUE (ward_id, number)
);

CREATE TABLE admin_wards (
  admin_id text NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  ward_id  text NOT NULL REFERENCES wards (id),
  PRIMARY KEY (admin_id, ward_id)
);

CREATE TABLE admin_booths (
  admin_id text NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  booth_id text NOT NULL REFERENCES booths (id),
  PRIMARY KEY (admin_id, booth_id)
);

-- Only a SHA-256 hash of each bearer token is stored.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,
  admin_id     text NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  device       text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_admin_idx ON sessions (admin_id);

CREATE TABLE voters (
  record_id    text PRIMARY KEY,
  voter_id     text NOT NULL,
  full_name    text NOT NULL,
  mobile       text NOT NULL DEFAULT '',
  ward_id      text NOT NULL REFERENCES wards (id),
  booth_id     text NOT NULL REFERENCES booths (id),
  house_number text NOT NULL,
  household_id text NOT NULL DEFAULT '',
  address      text NOT NULL DEFAULT '',
  status       text NOT NULL CHECK (status IN ('Active', 'Not Active', 'Shifted')),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
-- Voter IDs are text (leading zeros kept) and unique regardless of case.
CREATE UNIQUE INDEX voters_voter_id_ci_idx ON voters (upper(voter_id));
CREATE INDEX voters_household_idx ON voters (upper(household_id)) WHERE household_id <> '';
CREATE INDEX voters_ward_booth_idx ON voters (ward_id, booth_id);

-- Cash payments. The id is internal only (never shown to people); it links audit entries, cancel/reverse and retries.
CREATE TABLE payment_transactions (
  id              text PRIMARY KEY,
  voter_record_id text NOT NULL REFERENCES voters (record_id),
  voter_id        text NOT NULL,
  voter_name      text NOT NULL,
  ward_id         text NOT NULL,
  booth_id        text NOT NULL,
  amount          integer NOT NULL CHECK (amount BETWEEN 1 AND 100000),
  receiver_name   text NOT NULL,
  receiver_mobile text NOT NULL,
  "timestamp"     timestamptz NOT NULL,
  admin_id        text NOT NULL REFERENCES admins (id),
  admin_name      text NOT NULL,
  status          text NOT NULL CHECK (status IN ('Success', 'Cancelled', 'Reversed')),
  status_reason   text
);
-- One successful payment per voter. Cancelled/reversed records are kept and do not count.
-- The receiver is deliberately NOT unique: one person may receive for several household members.
CREATE UNIQUE INDEX payment_one_success_per_voter_idx ON payment_transactions (voter_record_id) WHERE status = 'Success';
CREATE INDEX payment_timestamp_idx ON payment_transactions ("timestamp");
CREATE INDEX payment_admin_idx ON payment_transactions (admin_id);
CREATE INDEX payment_ward_booth_idx ON payment_transactions (ward_id, booth_id);

CREATE TABLE idempotency_keys (
  admin_id   text NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  key        text NOT NULL,
  txn_id     text NOT NULL REFERENCES payment_transactions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_id, key)
);

CREATE TABLE audit_logs (
  id          text PRIMARY KEY,
  seq         bigint NOT NULL UNIQUE,
  "timestamp" timestamptz NOT NULL,
  admin_id    text NOT NULL,
  admin_name  text NOT NULL,
  action      text NOT NULL,
  entity      text NOT NULL CHECK (entity IN ('Admin', 'Ward', 'Booth', 'Voter', 'Import', 'Payment', 'Settings', 'Export', 'Auth')),
  record_ref  text NOT NULL,
  result      text NOT NULL CHECK (result IN ('Success', 'Failure')),
  summary     text NOT NULL
);
CREATE INDEX audit_timestamp_idx ON audit_logs ("timestamp" DESC, seq DESC);
CREATE INDEX audit_record_ref_idx ON audit_logs (record_ref);

-- Audit logs are append-only.
CREATE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- Single-row table holding the current payment settings.
CREATE TABLE payment_settings (
  id                    integer PRIMARY KEY CHECK (id = 1),
  default_amount        integer NOT NULL CHECK (default_amount BETWEEN 1 AND 100000),
  effective_date        date NOT NULL,
  allow_amount_override boolean NOT NULL
);

CREATE TABLE settings_history (
  id             text PRIMARY KEY,
  changed_at     timestamptz NOT NULL,
  changed_by     text NOT NULL,
  default_amount integer NOT NULL,
  effective_date date NOT NULL,
  summary        text NOT NULL
);

-- In-progress voter imports (rows arrive in batches; totals are kept here so any server instance can continue a job).
CREATE TABLE import_jobs (
  id         uuid PRIMARY KEY,
  admin_id   text NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  file_name  text NOT NULL,
  imported   integer NOT NULL DEFAULT 0,
  skipped    integer NOT NULL DEFAULT 0,
  failed     integer NOT NULL DEFAULT 0,
  errors     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
