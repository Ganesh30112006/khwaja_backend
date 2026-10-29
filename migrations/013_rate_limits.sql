-- Login and password-change attempt counters. They are kept here, not in each server's memory, so the limits
-- stay exact when the load balancer runs several API servers. Fixed windows: a key's count restarts at reset_at.
CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_reset_at_idx ON rate_limits (reset_at);
