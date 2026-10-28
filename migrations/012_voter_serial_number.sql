-- The voter's serial number in the ward roll (వార్డు ఓటర్ల జాబితా వరుస సంఖ్య, printed at the top of each voter
-- box). It belongs to the roll, so it is shared by every team like the Voter ID and ward. Optional: voters added
-- by hand or from a file without one have none. The voter list is sorted by ward, then serial number.
ALTER TABLE voters ADD COLUMN serial_number integer;
CREATE INDEX voters_ward_serial_idx ON voters (ward_id, serial_number);

-- Serial numbers an import filled in for voters that were already there (kept, not replaced).
ALTER TABLE import_jobs ADD COLUMN serials integer NOT NULL DEFAULT 0;
