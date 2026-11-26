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

**The invariant generalizes to state, not just counters:** a request that was
refused before dispatch must leave *no trace* — no shared budget spent, no row
written, no cooldown claimed. Reordering the gates here fixed the budget leak
but moved the pending-row insert ahead of the budget check, which reintroduced
the same class of bug as unbounded row creation. The final shape is: advisory
read with zero writes → atomic budget reservation (refusal writes nothing) →
create the row → atomic claim (a claim loser refunds its slot).

**Test shape that catches it:** seed the shared counter near its cap, send a
request the narrower gate will reject, then assert the counter did not move and
a subsequent legitimate request still gets the last unit. Revert the fix and
confirm the test fails — otherwise it is not testing the ordering. For a refund
or compensation branch, neutralize that statement (`sent - 1` → `sent + 0`) and
confirm the test fails; a test that passes either way proves nothing about it.
