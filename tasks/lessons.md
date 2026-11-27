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

## Cloudflare Cache Rules do not cache a Worker's own response

Creating a Cache Rule with `cache: true` for `/api/*` changed nothing: no
`cf-cache-status` appeared and every request still reached the Worker and D1.
The rule is evaluated around the Worker, but the Worker is the origin, so by
the time Cloudflare can cache anything the database read has already happened.

**Rule:** to cache Worker output, call `caches.default.match` / `put` in the
Worker. Verify with an explicit header (`X-Edge-Cache`), because the absence of
`cf-cache-status` is the only clue that nothing is being cached.

**Second trap in the same rule:** once caching did work, the response came back
with `max-age=14400` (the zone's 4-hour Browser Cache TTL) even though the
origin said 15 seconds. A browser polling the API would have shown four-hour-old
data. Set `browser_ttl: { mode: "respect_origin" }` (and usually
`edge_ttl: { mode: "respect_origin" }`) so the origin's TTL wins.

**Free plan:** the rate limiting API rejects any `mitigation_timeout` other than
10 with "not entitled to use a mitigation timeout different from 10". One rule
is allowed per zone; block returns 429 for the mitigation window.

**Cache keys must be canonical, not the raw URL.** Keying on `request.url`
lets anyone mint a new entry with `?junk=<random>`, filling the shared cache
and evicting the entries real traffic needs. Build the key from the parameters
the handler actually reads, after the same validation: invalid or ignored
values must collapse onto the representation they would otherwise get. Test it
by asserting the entry count stays 1 across different junk strings.

## A transient failure must not trigger a fixed long retry

The translation backfill retried a failed row after a flat hour. One transient
model error left a single announcement untranslated for an hour while every
other row was already done.

**Rule:** retry transient work on a short exponential backoff (30s doubling,
capped at an hour) driven by a per-row failure count, and reset the count on
success. A fixed long delay treats "the model hiccuped once" the same as "this
will never work". Filter rows by their own backoff rather than one SQL cutoff,
so a stuck row cannot block the ones behind it. Order independent cron jobs so
one failing subsystem cannot starve the others, and give operators an
authenticated trigger to retry immediately instead of waiting for a tick.

## A GET that mutates state breaks under HEAD and prefetch

`GET /api/v1/unsubscribe` removed the subscription. Mail scanners prefetch
links, and a HEAD request is served by the GET path, so either could
unsubscribe a reader who never clicked. Same class as the earlier confirm link.

**Rule:** state changes are POST-only. A GET behind an email link renders a
confirmation form; the form posts. When adding a global HEAD → GET shim, audit
every GET route for writes first — the shim makes an existing bad GET easier to
trigger, it does not create the bug.

## Third-party fonts are a performance and layout-shift decision

The page loaded three families from `fonts.googleapis.com`. PSI mobile measured
a render-blocking chain (~710 ms) and CLS 0.35; the local Lighthouse trace named
`section.banner-stack` and the cause was literally "Web font loaded" (JetBrains
Mono swapping in after first paint).

**Rule:** self-host the fonts you actually use, preload the ones needed above
the fold, and keep `font-display: optional` for any face whose fallback metrics
differ enough to move layout. Google's CSS URL is convenient but puts a third
party in the critical path and hides which file is late. Three variable woff2
files replaced a 12 KB CSS request plus seven font fetches.

**How to verify:** `lighthouse_agentic.py` / PSI for CLS, and a `layout-shift`
PerformanceObserver in a cold isolated browser context. A warm cache hides the
problem completely — unregister the service worker and clear caches first.

## An alternate representation that points at another page is a lie

Every guide page advertised `/index.md` as its Markdown alternate, and
`/guide.md` returned 404. The header looked correct in isolation, which is why
it survived earlier audits.

**Rule:** every `rel="alternate"` must resolve to an equivalent representation
of that exact URL, and the target must return 200. When a template has no real
mirror, omit the link instead of borrowing the homepage's. Test it by fetching
each indexable URL, reading its alternate href, and asserting the target is 200
with the right content type.
