-- A ward can have several Corporators (each with its own BLOs: a "team", identified by the Corporator's ID).
-- They share the ward's voter list; each team keeps its own changes, payments and permissions.

-- One team's own view of a shared voter: edited details (when `details`), its own status, or hidden for it.
CREATE TABLE voter_overrides (
  team_id         text NOT NULL REFERENCES admins (id),
  voter_record_id text NOT NULL REFERENCES voters (record_id) ON DELETE CASCADE,
  details         boolean NOT NULL DEFAULT false,
  full_name       text,
  booth_id        text REFERENCES booths (id) ON DELETE SET NULL,
  house_number    text,
  household_id    text,
  address         text,
  age             integer,
  gender          text,
  status          text CHECK (status IN ('Active', 'Dead', 'Shifted')),
  hidden          boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, voter_record_id)
);

-- Payments belong to the team that made them: a Corporator's own, or its BLO's. Payments a Super Admin made
-- before this change go to the ward's Corporator (the first by number when there are several).
ALTER TABLE payment_transactions ADD COLUMN team_id text REFERENCES admins (id);
UPDATE payment_transactions t
SET team_id = CASE a.role WHEN 'CORPORATOR' THEN a.id WHEN 'BLO' THEN a.corporator_id END
FROM admins a WHERE a.id = t.admin_id;
UPDATE payment_transactions t
SET team_id = (SELECT c.id FROM admin_wards aw JOIN admins c ON c.id = aw.admin_id AND c.role = 'CORPORATOR'
               WHERE aw.ward_id = t.ward_id ORDER BY split_part(c.id, '-', 2)::int LIMIT 1)
WHERE t.team_id IS NULL;
-- One successful payment per voter for each team.
DROP INDEX payment_one_success_per_voter_idx;
CREATE UNIQUE INDEX payment_one_success_per_team_idx ON payment_transactions (voter_record_id, team_id) WHERE status = 'Success';
CREATE INDEX payment_team_idx ON payment_transactions (team_id);

-- Permission to pay a Shifted voter is given per team.
ALTER TABLE shifted_approvals ADD COLUMN team_id text REFERENCES admins (id);
UPDATE shifted_approvals s SET team_id = COALESCE(
  (SELECT CASE a.role WHEN 'BLO' THEN a.corporator_id WHEN 'CORPORATOR' THEN a.id END FROM admins a WHERE a.id = s.requested_by),
  (SELECT a.id FROM admins a WHERE a.id = s.decided_by AND a.role = 'CORPORATOR'),
  (SELECT c.id FROM voters v JOIN admin_wards aw ON aw.ward_id = v.ward_id JOIN admins c ON c.id = aw.admin_id AND c.role = 'CORPORATOR'
   WHERE v.record_id = s.voter_record_id ORDER BY split_part(c.id, '-', 2)::int LIMIT 1));
DELETE FROM shifted_approvals WHERE team_id IS NULL;
ALTER TABLE shifted_approvals ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE shifted_approvals DROP CONSTRAINT shifted_approvals_pkey;
ALTER TABLE shifted_approvals ADD PRIMARY KEY (voter_record_id, team_id);

-- A team's own payment amount for a ward (wards.payment_amount stays as the Super Admin's amount for the ward).
CREATE TABLE team_ward_amounts (
  ward_id text NOT NULL REFERENCES wards (id),
  team_id text NOT NULL REFERENCES admins (id),
  amount  integer NOT NULL CHECK (amount BETWEEN 1 AND 100000),
  PRIMARY KEY (ward_id, team_id)
);
