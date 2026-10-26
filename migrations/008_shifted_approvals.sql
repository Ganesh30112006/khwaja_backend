-- Shifted voters can be paid, but a BLO needs its Corporator's permission first. One row per voter
-- holds the latest request/decision (a Corporator may also approve without a request).
CREATE TABLE shifted_approvals (
  voter_record_id text PRIMARY KEY REFERENCES voters (record_id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('Pending', 'Approved', 'Rejected')),
  requested_by    text REFERENCES admins (id),
  requested_at    timestamptz,
  decided_by      text REFERENCES admins (id),
  decided_at      timestamptz
);
CREATE INDEX shifted_approvals_pending_idx ON shifted_approvals (status) WHERE status = 'Pending';
