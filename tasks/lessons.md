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

## A relative-time answer needs an absolute day boundary

The homepage FAQ answered "Did Antigravity reset today?" with "Yes. … announced
an official reset 17 hours ago". Seventeen hours before 00:30 UTC is the
previous UTC day, so for the first hours of every day the answer was wrong —
and the same string was copied into the FAQ JSON-LD and the Markdown mirror.

**Rule:** any answer that contains the word "today" must compute the calendar
day explicitly, in a named timezone, and state an `as of` timestamp. Put the
absolute time before the relative one ("Nov 26, 2026, 07:19 UTC (17 hours
ago)"), because the relative phrase alone is not checkable. Test both branches
by offsetting the timestamp from the current UTC day — a test that only checks
the happy branch will pass forever.

## `sameAs` asserts identity, not attribution

The Organization node listed `https://x.com/_mohansolo` in `sameAs`. The site
tracks that account; it is not that account. `sameAs` means "this URL
unambiguously identifies the same entity", so the markup told search and AI
engines the tracker *was* the Google employee it monitors, contradicting the
footer's independence statement.

**Rule:** only list profiles the site itself operates. The tracked person
belongs in the description, the FAQ prose, and each announcement's author —
never in `sameAs`. Compare with a peer's markup before assuming a pattern is
industry practice: codex-resets.com lists its own accounts only.

## Run the plugin's own capability check before declaring a service absent

I checked `env | grep GOOGLE_`, saw no Search Console key, and told the user
there were no Google credentials. The plugin stores them at
`~/.config/claude-seo/google-api.json` and exposes `google_auth.py --check` for
exactly this. The check would have shown a working GSC service account; the
real blocker was a property-level permission, not a missing credential.

**Rule:** when a tool ships a `--check` for a capability, run that, not an
improvised probe. Report "the account cannot see this property" separately from
"no credentials exist" — they lead to different fixes.

## A clean `git status` is not enough in a shared working directory

Another agent session switched HEAD in the same worktree between my
`git checkout -b` and my `git add -A && git commit`. The commit landed on
`codex/fix-linux-do-badge`, and the follow-up push created an empty branch
under the name I intended. No work was lost, but the other session's branch
was briefly ahead by a commit it did not author.

**Rules:**
- Before committing, print `git status --short --branch` and confirm the
  branch is the one you expect. A clean tree only says nothing is untracked.
- Never `git add -A` in a worktree other sessions may share. Stage explicit
  paths so their files cannot be swept into your commit.
- Give any branch you will commit on its own `git worktree`. The main
  checkout is not a lock.
- If a commit lands on the wrong branch: cherry-pick it onto the right base in
  a temporary worktree, restore the other branch to its original tip with
  `git reset --hard <tip>` only after confirming the tree is clean, and never
  force-push someone else's branch.

## A test that matches text every page carries cannot detect a locale regression

The history locale test asserted `html.includes(SITE + "/zh-CN/history")`.
Every history page lists all locales in its hreflang alternates, so a render
that ignored the requested locale would still pass. The sitemap test had the
same shape: it searched the whole document for each URL.

**Rule:** assert per-page invariants instead of document-wide substrings —
`Content-Language`, `<html lang>`, the exact self-referencing canonical, and
the page's own Markdown alternate. For sitemap entries, parse each `<url>`
block and inspect that block's alternates.

## Inbound protection cannot fix an outbound rate limit

Worker logs showed `429 TooManyRequests` from api.indexnow.org while the same
payload from a local machine returned 202. Cloudflare's free inbound controls —
Turnstile, Browser Integrity Check, WAF, rate limiting — protect visitors to
the zone; they do not proxy or vouch for a Worker's outbound subrequests, and
Workers have no dedicated egress IP to register with a third party.

**Rule:** when an outbound call is rate-limited by a shared egress pool, no
amount of inbound configuration or retrying helps. Use an authenticated API
(Bing Webmaster SubmitUrlbatch with a site-verified key), move the sender to a
network you control, or treat the push as best-effort and keep sitemap +
`lastmod` as the source of truth. Also scrub credentials from anything
loggable: the BWT key is a query parameter, so log error classes and redact
`apikey=` from response bodies.
