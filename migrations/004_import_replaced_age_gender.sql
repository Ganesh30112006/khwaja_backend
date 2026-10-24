-- Imports can replace an existing voter's details (same Voter ID) when the user chooses to.
ALTER TABLE import_jobs ADD COLUMN replaced integer NOT NULL DEFAULT 0;

-- Age and gender as printed on the electoral roll (వయస్సు / లింగము); both optional.
ALTER TABLE voters ADD COLUMN age smallint CHECK (age BETWEEN 18 AND 120);
ALTER TABLE voters ADD COLUMN gender text NOT NULL DEFAULT '' CHECK (gender IN ('', 'Male', 'Female', 'Other'));
