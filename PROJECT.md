# link-check-proxy — Design Document

Status: **Draft v0.2** (2026-11-10)

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
- `GET /v1/admin/stats`: URL counts by state, queue depth, checks/day, top
  hosts.

## 5. Data model

```sql
CREATE TABLE urls (
  url                TEXT PRIMARY KEY,   -- normalized, no fragment
  host               TEXT NOT NULL,
  status             INTEGER,            -- last HTTP status, NULL if none
  error              TEXT,               -- error kind, NULL if none
  final_url          TEXT,               -- after redirects
  checked_at         INTEGER,            -- epoch seconds
  next_check_at      INTEGER NOT NULL,   -- scheduler key
  first_seen_at      INTEGER NOT NULL,
  last_requested_at  INTEGER NOT NULL,   -- coarse (see §6.5)
  request_count      INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  idle_level         INTEGER NOT NULL DEFAULT 0  -- exponential backoff exponent
);
CREATE INDEX urls_next_check ON urls(next_check_at);
CREATE INDEX urls_host ON urls(host);

CREATE TABLE hosts (
  host            TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL DEFAULT 0,   -- politeness gate
  backoff_until   INTEGER NOT NULL DEFAULT 0,   -- from 429 / Retry-After
  min_interval_s  INTEGER NOT NULL DEFAULT 5    -- per-host override hook
);

CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 of the key
  name        TEXT NOT NULL,
  owner       TEXT,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  new_url_quota_per_day INTEGER NOT NULL DEFAULT 5000,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
```

Keys look like `lcp_<32 random base62 chars>`. Only their hash is stored.

## 6. Checking & scheduling

### 6.1 Fetch policy

- `HEAD` first. If the response is `405`, `403` or `501`, or the request
  errors, retry once with `GET`. The `GET` response body is cancelled right
  away, without reading it.
- Follow redirects manually, at most 10 hops. Record `final_url`. The
  `status` we record is the final hop's status. *Later: keep the first hop's
  status too, to detect permanent redirects.*
- Timeout: 15 s per request.
- User-Agent:
  `link-check-proxy/<version> (+https://<project-url>; contact)`.
- Politeness: at most 1 in-flight request per host per tick, and at least
  `min_interval_s` (default 5 s) between requests to the same host.
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
budget. So the API updates it only when the stored value is older than 1 h,
in a single batched `UPDATE … WHERE url IN (…)`. `request_count` is
incremented in that same update, so it counts "requested hours" rather than
raw hits. That is enough to decide whether a URL is hot.

### 6.6 New (unknown) URLs: spread over time

New URLs are inserted with `next_check_at = now`. Each tick, the scheduler:

1. selects due URLs ordered by priority:
   1. unknown URLs, oldest `first_seen_at` first
   2. hot URLs about to go stale
   3. everything else, by `next_check_at`
2. skips hosts that are backing off or not yet allowed,
3. takes at most one URL per host and at most N (≈40) in total,
4. checks them concurrently and writes all results in one batch.

A burst of new URLs, such as a new project sending 3,000 links, therefore
spreads out naturally over minutes or hours: limited globally by the per-tick
budget, and per host by politeness. No explicit random delay is needed.

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
- An admin key is bootstrapped from a Worker secret.
- Observability: structured logs, and a `/v1/admin/stats` endpoint.
- Tests: unit tests for the pure scheduler and classification logic, and
  integration tests with Miniflare / `wrangler dev`.

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