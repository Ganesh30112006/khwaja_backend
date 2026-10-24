-- Ward voter rolls have no booth, so a voter's booth is optional (a voter without one is covered by
-- whoever covers the whole ward). Voters no longer have a mobile number; payments keep the receiver's.
ALTER TABLE voters ALTER COLUMN booth_id DROP NOT NULL;
ALTER TABLE payment_transactions ALTER COLUMN booth_id DROP NOT NULL;
ALTER TABLE voters DROP COLUMN mobile;
