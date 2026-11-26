-- Intentionally a no-op.
--
-- An earlier revision mass-confirmed every legacy row. That would have
-- activated addresses nobody re-verified, which defeats the point of double
-- opt-in: an unconfirmed row is exactly an address somebody typed into a public
-- form. Legacy rows therefore stay confirmed = 0. Their owners can subscribe
-- again, and a one-time reconfirmation send can be run separately once someone
-- decides that is the right call for the addresses on file.
SELECT 1;
