# Automatic X reset posts

Apply D1 migration `0008_x_post_deliveries.sql` before deploying the Worker. It
creates an empty delivery table. The webhook and minute cron both look for new
events in the existing notification snapshots. An event is eligible when both
its source timestamp and snapshot creation time are at or after activation.
The Worker posts confirmed resets and explicit expected resets that are still
pending. It skips unconfirmed watch hints and closed announcements.

On an X developer app with **Read and Write** permissions, obtain OAuth 1.0a
user credentials for **@agy_resets**. Store the app key and secret as
`X_POST_API_KEY` and `X_POST_API_KEY_SECRET`. Store the user token and secret
as `X_POST_ACCESS_TOKEN` and `X_POST_ACCESS_TOKEN_SECRET`. Use the project's
Infisical sync or Cloudflare Worker secrets. Set `X_POSTS_START_AT` to the
current UTC time in ISO 8601 format when ready to enable posting. Leave it
unset to keep posting disabled. The Worker verifies the authorized username
before publishing.

Posts include the tracker URL and the original X post URL. X restricts the
native quote field to Enterprise. Check the developer app's balance and
[current X API pricing](https://docs.x.com/x-api/getting-started/pricing)
before enabling, since posts with URLs have their own rate.

`x_post_deliveries` records the outcome and the X post ID. HTTP 429 schedules
another attempt. A lost response, server-side error, or abandoned claim is
recorded as ambiguous. Inspect the account before reconciling an ambiguous
row. If the post exists, record its ID and mark the row sent. A failed or
ambiguous row can be set to `retry` with `retry_at = 0` after confirming that
no post was created and addressing the failure.
