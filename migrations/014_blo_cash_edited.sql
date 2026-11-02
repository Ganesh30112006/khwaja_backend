-- A Corporator can correct a cash entry it gave a BLO; when it last did so.
ALTER TABLE blo_cash ADD COLUMN edited_at timestamptz;
