# Lessons

## Rate-limit gate ordering: a rejected request must not spend a shared budget

`POST /api/v1/subscribe/email` reserved a global hourly send slot before
claiming the per-address cooldown. Requests rejected by the cooldown sent
nothing but still consumed a slot, so posting one address repeatedly drained
the 100/hour cap and returned 429 to every other subscriber — an
unauthenticated denial of service on the whole feature.

**Rule:** order abuse gates from narrow-and-specific to broad-and-shared. A
gate that rejects a request must run before any counter that request would
otherwise increment. When several limits apply, only a request that passes all
of them may spend a shared resource.

**Test shape that catches it:** seed the shared counter near its cap, send a
request the narrower gate will reject, then assert the counter did not move and
a subsequent legitimate request still gets the last unit. Revert the fix and
confirm the test fails — otherwise it is not testing the ordering.
