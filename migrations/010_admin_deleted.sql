-- A Super Admin can delete Corporators and BLOs. The row stays so past payments, cash records and audit
-- entries keep their account; a deleted account is hidden everywhere, cannot sign in, and its mobile
-- number is freed (replaced by "deleted:<id>").
ALTER TABLE admins ADD COLUMN deleted_at timestamptz;
