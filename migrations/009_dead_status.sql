-- "Not Active" (used for deceased voters) is renamed "Dead". Dead voters are never paid.
ALTER TABLE voters DROP CONSTRAINT voters_status_check;
UPDATE voters SET status = 'Dead' WHERE status = 'Not Active';
ALTER TABLE voters ADD CONSTRAINT voters_status_check CHECK (status IN ('Active', 'Dead', 'Shifted'));
