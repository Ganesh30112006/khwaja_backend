-- A Super Admin can create more Super Admins (SA-2, SA-3, ...). The counter starts after the existing ones.
INSERT INTO counters (name, value)
SELECT 'super_admin', COALESCE(max(split_part(id, '-', 2)::int), 0) FROM admins WHERE role = 'SUPER_ADMIN'
ON CONFLICT (name) DO NOTHING;
