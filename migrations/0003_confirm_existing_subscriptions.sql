-- Rows created before double opt-in were submitted through the site form by
-- the address owner, which is itself the opt-in signal. New rows start with
-- confirmed = 0 and only become active after the confirmation email is clicked.
UPDATE email_subscriptions SET confirmed = 1;
