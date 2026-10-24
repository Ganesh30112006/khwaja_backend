-- The name of the person who handed over the cash, typed on the payment form (prefilled with the account name).
ALTER TABLE payment_transactions ADD COLUMN given_by_name text NOT NULL DEFAULT '';
UPDATE payment_transactions SET given_by_name = admin_name;
