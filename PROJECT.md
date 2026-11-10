# link-check-proxy — Design Document

Status: **v0.4**, deployed; monitoring CLI added (2026-11-10)

Audience: a small, community-run service for Jupyter and Scientific Python
projects (NumPy, SciPy, …). Keep it simple; scale later.

## 1. Problem

Many CI jobs across many repositories run link checkers (Sphinx `linkcheck`,
lychee, markdown-link-check, …). Each run independently hits every external
URL, often on every push / PR, which:

- hammers the target services (and gets CI rate-limited / banned: 429s, 403s),
- makes CI slow and flaky because of transient remote failures,
- duplicates identical work across projects that link to the same places
  (docs.python.org, github.com, doi.org, …).

## 2. Goal

A centralized, shared **link status cache** ("proxy"). Clients send one JSON
request with all the URLs they want to check, and get an answer
**immediately** from cache. The service checks the URLs itself in the
background, slowly and politely, and keeps results fresh for URLs that are
actually being asked about.

### Non-goals (v1)

- Client integrations (Sphinx extension, lychee wrapper, GitHub Action). Each
  client decides how to use the answers; we only define the API.
- Anchor/fragment checking (see §10 Future work).
- Acting as a real HTTP(S) proxy. It is a JSON API, not a forward proxy.
- Checking private/internal URLs.

## 3. High-level architecture

```
  CI job ──POST /v1/check──▶  API (Worker)  ──read/insert──▶  DB (D1 / SQLite)
                                                                 ▲
                         Cron trigger (every minute)             │
                               │                                 │
                               ▼                                 │
                        Scheduler: pick due URLs ──▶ Checker ──write results
                        (global budget + per-host limits)   (outbound fetch)
```

Three logical components, which can be deployed together:

1. **API**: authenticates, normalizes URLs, returns what the cache knows,
   registers new URLs, and records that each URL was requested.
2. **Scheduler**: on each tick, picks the URLs that are due for a check. It
   respects a global budget per tick and per-host politeness limits.
3. **Checker**: fetches URLs and classifies the outcomes.

The scheduling and classification logic is written as pure functions,
separate from any platform. Storage and fetching sit behind small interfaces,
so the same core can run on Cloudflare or on a plain VPS with SQLite. The
checker is designed so it *could* later be a pull-based external worker (see
§9, Cloudflare-IP blocking).

### Platform choice

**Cloudflare Workers + D1 + Cron Triggers, in TypeScript.** It is free, easy to
deploy, and has no servers to maintain. Fetch time spent waiting on the
network does not count toward the Worker CPU limit, so I/O-bound checking
fits well.

Constraints of the free tier that shape the design (verify against the
current Cloudflare docs before relying on them):

| Limit (free tier, approx.)        | Consequence                                         |
|-----------------------------------|-----------------------------------------------------|
| ~50 subrequests per invocation    | Cron tick checks ≤ ~40 URLs → ≤ ~57k checks/day     |
| 10 ms CPU per invocation          | Keep parsing minimal; no body parsing in v1         |
| Cron granularity: 1 minute        | Scheduler tick = 1 min                              |
| D1: ~100k row writes/day          | Batch writes; throttle `last_requested_at` updates  |
| D1: ~5M row reads/day             | Index lookups only; avoid scans in hot path         |

If we outgrow the free tier, the $5/month paid plan raises all of these
limits by orders of magnitude without design changes.

## 4. API

All endpoints are versioned under `/v1`. Auth: `Authorization: Bearer <key>`.

### `GET /` (public)

This is the only endpoint that needs no key. When `Accept` includes
`text/html` (a browser), it returns the consumer page (`src/home.ts`). That
page explains what the service is, how to request a key through the GitHub
issue form, how to read the results, and gives a GitHub Actions example.
Otherwise it returns `{"service": "link-check-proxy", "docs": <repo URL>}`.
The outbound User-Agent links to the repository, so site operators can find
out who is checking their URLs.

### `POST /v1/check`

Request:

```json
{ "urls": ["https://docs.python.org/3/", "https://example.org/foo#bar"] }
```

- Max 1000 URLs per request (configurable).
- Fragments are stripped before lookup and returned in the response under
  the original string. They are kept as a hook for future anchor checking.

Response (always fast, never blocks on outbound checks):

```json
{
  "results": {
    "https://docs.python.org/3/": {
      "state": "fresh",
      "status": 200,
      "error": null,
      "final_url": "https://docs.python.org/3/",
      "checked_at": "2026-11-10T08:12:03Z",
      "consecutive_failures": 0
    },
    "https://example.org/foo#bar": {
      "state": "unknown",
      "status": null,
      "error": null,
      "final_url": null,
      "checked_at": null,
      "consecutive_failures": 0
    }
  }
}
```

`state` is one of:

| state     | meaning                                                         |
|-----------|-----------------------------------------------------------------|
| `fresh`   | Result is within its TTL.                                       |
| `stale`   | Result exists but is past its TTL; a re-check is scheduled.     |
| `unknown` | Never checked yet; it is now queued.                            |
| `rejected`| URL not acceptable (bad scheme, private IP, too long, …).       |

`error` (when there is no HTTP status, or alongside one) is one of:
`dns`, `connect`, `tls`, `timeout`, `too_many_redirects`, `invalid_url`,
`blocked` (private address / disallowed), `other`.

**Clients decide** what `unknown` / `stale` / failures mean for them (pass,
warn, fall back to a local check, …). The server never decides "broken"
vs "ok".

### `GET /v1/url?u=<url>`

Single-URL lookup, mainly for debugging. Same result shape. Includes the
check history summary (next scheduled check, idle level).

### Admin endpoints (admin key only)

- `POST /v1/admin/keys` with `{name, owner, quota}` → `{id, key}`. The
  plaintext key is shown only this once.
- `GET /v1/admin/keys`, `DELETE /v1/admin/keys/:id` (revoke)
- `GET /v1/admin/overview?limit=N`: cheap, safe to poll. It returns:
  - the cached full counts (recomputed hourly by the cron job),
  - the last tick's report,
  - the number of due URLs (counted up to 1000),
  - the next N URLs in schedule order,
  - the last N checks (a log of the most recent 100, kept in the `meta`
    table).

  `tools/lcp_status.py` renders it for `watch`.
- `GET /v1/admin/stats`: live URL counts by state. It scans the whole table,
  so don't poll it.

## 5. Data model

The schema lives in `migrations/`. It has five tables:

- `urls`: one row per normalized URL (fragment stripped). It holds the last
  result (`status`, `error`, `final_url`, `checked_at`, `expires_at`) and the
  scheduling state (`next_check_at`, `last_requested_at`, `request_count`,
  `consecutive_failures`, `idle_level`). It is indexed on `next_check_at`,
  plus a partial index for never-checked rows.
- `meta`: small JSON key/value entries (cached stats, last tick, recent
  checks) for the admin overview.
- `hosts`: `backoff_until` for each host, set from 429 / `Retry-After`. This
  is also where per-host policy overrides will go later.
- `api_keys`: keys stored as SHA-256 hashes, each with an `is_admin` flag, a
  daily new-URL quota, and a `revoked_at` timestamp.
- `api_key_usage`: number of new URLs added per key per UTC day.

Tables use `WITHOUT ROWID` where the primary key is the natural lookup key,
which saves one index write per row.

Keys look like `lcp_<32 random base62 chars>`. Only their hash is stored.

### D1 query budget

The free tier of D1 limits the number of queries per invocation and allows at
most 100 bound parameters per statement. So every bulk operation (lookup,
insert, touch, applying results) passes its rows as **one JSON parameter**,
expanded with `json_each()`. A `/v1/check` call costs about 6 queries, and a
cron tick about 5.

## 6. Checking & scheduling

### 6.1 Fetch policy

- `HEAD` first. If the response is `403`, `404`, `405` or `501`, or the
  request errors, retry once with `GET`. (Some servers answer `404` to `HEAD`
  only.) The `GET` response body is cancelled right
  away, without reading it.
- Follow redirects manually, at most 10 hops. Record `final_url`. The
  `status` we record is the final hop's status. *Later: keep the first hop's
  status too, to detect permanent redirects.*
- Timeout: 15 s per request.
- User-Agent:
  `link-check-proxy/<version> (+https://<project-url>; contact)`.
- Politeness: at most one URL per host per tick, so roughly one per minute
  per host.
- Each tick has a **fetch budget** of 45 outbound fetches, under the Workers
  subrequest limit. Every redirect hop and every HEAD→GET retry counts
  against it. A check that runs out of budget is *deferred*: nothing is
  recorded and it is picked again next tick. At most 6 fetches run at once.
- A response with `cf-mitigated: challenge` is recorded with its status and
  `error: "challenged"`.
- `429`: honor `Retry-After` (default 1 h if it is missing) by setting
  `hosts.backoff_until`. The URL is rescheduled, and the 429 is **not**
  recorded as the URL's result.

### 6.2 TTL by outcome

The next check is scheduled at `checked_at + TTL × jitter(0.9–1.1)`.

| Outcome                       | TTL                                     |
|-------------------------------|-----------------------------------------|
| 2xx                           | 24 h                                    |
| 3xx (final, unresolved)       | 24 h                                    |
| 4xx (except 429)              | 6 h, so fixes are seen quickly          |
| 5xx, timeout, connect, dns, tls | 15 min × 2^(failures−1), capped at 24 h |

These are defaults. A per-host override (and later per-URL tuning) can be
added through the `hosts` table.

### 6.3 Hot URLs: refresh before expiry

If a URL has been requested since its last check, it is "hot". For a hot
URL, the next check is moved forward to `checked_at + 0.8 × TTL`, so it gets
refreshed before it goes stale while CI is still asking for it.

### 6.4 Idle URLs: exponential backoff, then drop

When the scheduler checks a URL that has **not** been requested since its
last check:

- increment `idle_level`
- next interval = `TTL × 2^idle_level`, capped at 7 days

Any request resets `idle_level` to 0. A URL is **dropped** when
`now − last_requested_at > 30 days`; a daily cleanup in the cron job does
this. If it is requested again later, it simply comes back as `unknown`.

### 6.5 Write budget: coarse request tracking

Updating `last_requested_at` on every request would use up the D1 write
budget (about 100k rows/day on the free tier, and index entries count too).
So the API rewrites it only when the stored value is older than **12 h**
(`requestTouchInterval`), in one batched statement. `request_count` counts
these touches, not raw hits.

Because of that coarseness, a URL counts as "hot" if
`last_requested_at >= checked_at - 12h`. The same touch also resets
`idle_level` to 0. If the URL had gone idle, its next check is pulled
forward to the hot-refresh point (or to now, if it has already expired).

Rough sizing for the free tier: each active URL costs about 5 row writes per
day, so it can handle on the order of 10–15k actively requested URLs.

### 6.6 New (unknown) URLs: spread over time

When one request adds several new URLs for the same host, they are inserted
with `next_check_at` spaced **60 s apart**. A project adding 3,000 GitHub
links therefore trickles out instead of clogging the head of the queue.

Each tick (every minute), the scheduler:

1. reads up to 200 never-checked due URLs and up to 200 due URLs of any
   kind, both ordered by `next_check_at` (hot URLs come early because they
   are scheduled at 80% of their TTL),
2. skips hosts that are backing off,
3. takes at most one URL per host and at most 20 in total,
4. checks them, at most 6 at a time and within the fetch budget, and
   writes all results in one statement.

On a 429, the host's `backoff_until` is set, and **all** of that host's
pending URLs are pushed past it.

## 7. Security & abuse

- Only `http`/`https`. Reject URLs that are longer than 2048 chars or that
  carry credentials (`user:pass@`).
- Reject literal IPs in private, loopback and link-local ranges, and
  `localhost`. (Workers egress cannot reach private networks anyway, but the
  service should not depend on that.)
- Per-key **new-URL quota per day**. It limits how far the service can be
  used to amplify traffic toward arbitrary targets. Lookups of URLs that are
  already known are cheap and limited only by the request rate.
- The cache is shared across all keys. Results are public information about
  public URLs.
- Keys are stored as hashes, can be revoked, and are issued by an admin.

## 8. Deployment & operations

- `wrangler` project, with D1 migrations in `migrations/`.
- One Worker that has both a `fetch` handler (API) and a `scheduled` handler
  (cron `* * * * *`).
- The admin credential is the `ADMIN_TOKEN` Worker secret. Keys created with
  `"admin": true` are admins too.
- URLs that have not been requested for 30 days are dropped once a day, by
  the tick at 03:00 UTC.
- Every tick logs one `tick {...}` line (`wrangler tail`). It also stores its
  report and adds to the recent-checks log in `meta`. The tick at minute 0 of
  each hour recomputes the full counts.
- Monitoring: `tools/lcp_status.py`, run under `watch`, shows the counts, the
  queue head and recent checks, from `/v1/admin/overview`. It flags a stalled
  cron when the last tick is more than 3 minutes old.
- Schema changes are new numbered files in `migrations/`. Apply them
  **before** deploying the code that needs them.
- Tests (`npm test`): unit tests for the pure policy, URL and checker logic,
  plus end-to-end tests of the API and scheduler. These run against the real
  migration on `node:sqlite`, through a small D1-compatible shim.

## 9. Risks

- **Sites that block Cloudflare egress IPs** or present bot challenges (some
  CDNs, academic publishers). The proxy may see a `403` or `503` that a CI
  runner would not. Mitigations:
  - detect challenge pages (e.g. `cf-mitigated` header, `403` with
    `server: cloudflare`) and add an error kind like `challenged`;
  - later, add optional external checker nodes that pull work for flagged
    hosts.
- **Free-tier ceilings.** About 57k checks/day is plenty for tens of
  thousands of URLs at 24 h TTLs, but not for millions. The paid plan is
  the escape hatch.
- **Stale reporting.** A link that broke within the last TTL window is
  reported as OK. That is the accepted trade-off; clients can choose to
  treat `stale` differently.

## 10. Future work

- **Anchor checking:** on `GET`, parse the HTML for `id`/`name` attributes
  and store the set (or a hash) per URL. Clients then ask about
  `url#fragment`. This needs body parsing, so it probably requires the paid
  tier's CPU budget.
- Client integrations: Sphinx extension, lychee/markdown-link-check
  wrappers, GitHub Action.
- Per-host and per-URL policy tuning, learned from observed flakiness.
- GitHub OIDC auth, so no secret has to be distributed.
- A published static status page listing every cached URL and its state.
  Regenerated periodically, it would let anyone (including fork PRs) read
  results without a key and without triggering any check.
- Optional `wait_ms` on `/v1/check`, to check a small number of unknown URLs
  synchronously.
- Stats on that page: most-linked dead URLs, per-host health.

## 11. Decisions

- **Scope:** one small, community-run instance for Jupyter and the
  Scientific Python ecosystem (NumPy, SciPy, …). Keep it small and scale
  later. The free tier is expected to be enough.
- **API keys:** created by hand by an admin and given to projects directly.
  No self-serve signup.
- **No anonymous access:** every request without a valid key is refused
  with `401`. Unauthenticated callers can never cause an outbound check.
- **License:** MIT.
- **Hosting:** the default `*.workers.dev` URL for now. The name and domain
  can be decided later.
- **Client side:** out of scope for v1. Each client decides how to treat
  `unknown`, `stale` and failures.
- **Anchors:** not in v1 (see Future work).
- **Fetch policy and TTLs:** as in §6. Per-URL tuning comes later, based on
  what we observe.