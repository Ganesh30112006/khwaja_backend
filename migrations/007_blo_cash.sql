-- Cash a Corporator hands to one of its BLOs to pay out (a negative entry = money taken back).
-- What a BLO has left = the sum of these minus its successful payments.
CREATE TABLE blo_cash (
  id       bigserial PRIMARY KEY,
  blo_id   text NOT NULL REFERENCES admins (id),
  amount   integer NOT NULL CHECK (amount <> 0 AND amount BETWEEN -10000000 AND 10000000),
  note     text NOT NULL DEFAULT '',
  given_by text NOT NULL REFERENCES admins (id),
  given_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blo_cash_blo_idx ON blo_cash (blo_id);
