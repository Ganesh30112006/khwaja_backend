-- A ward's own payment amount (set by its Corporator or a Super Admin). NULL uses the overall amount from
-- payment settings.
ALTER TABLE wards ADD COLUMN payment_amount integer CHECK (payment_amount BETWEEN 1 AND 100000);
