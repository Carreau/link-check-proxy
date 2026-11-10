# link-check-proxy

A shared link-status cache for CI link checkers in the Jupyter and Scientific
Python ecosystem. Instead of every CI run hitting every external URL, clients
ask this service, which answers right away from its cache and checks the URLs
itself in the background, slowly and politely.

For the design, see [PROJECT.md](PROJECT.md). For a complete client example
(pytest, GitHub OIDC, public-snapshot fallback for fork PRs), see
[intersphinx_registry #129](https://github.com/Quansight-Labs/intersphinx_registry/pull/129). Using the service from your
project's CI? Open https://link-check-proxy.carreau.workers.dev in a browser
for consumer instructions, or
[request an API key](https://github.com/carreau/link-check-proxy/issues/new?template=api-key.yml).

## API

> **Every URL submitted to the service becomes public.** URLs and their
> results are stored and published in the public snapshot at
> `/v1/snapshot.json`, which anyone can download without a key. Key holders
> must only submit URLs that are already public. Never submit private or
> internal URLs, or URLs that carry tokens, signed parameters or personal
> data.

All `/v1/*` endpoints require `Authorization: Bearer <credential>`, except
`/v1/snapshot.json`. The credential is an API key, or a GitHub Actions OIDC
token from an allowlisted org or repository (see [GitHub OIDC](#github-oidc)).
The root `/` is public. Browsers get a page for consumers (from
`src/home.ts`); API clients get a small JSON blob.

```console
$ curl -s $LCP_URL/v1/check \
    -H "Authorization: Bearer $LCP_KEY" \
    -d '{"urls": ["https://numpy.org/", "https://scipy.org/nope"]}'
{"results": {
  "https://numpy.org/":     {"state": "fresh", "status": 200, ...},
  "https://scipy.org/nope": {"state": "unknown", "status": null, ...}}}
```

`state` is `fresh`, `stale`, `unknown` or `rejected`. The client decides what
to do with each. See PROJECT.md §4.

### Public snapshot (no key)

Callers without a key, such as CI on pull requests from forks, can download
every result at once. Fetching it never adds URLs and never triggers checks.

```console
$ curl -s $LCP_URL/v1/snapshot.json
{"format": 1, "generated_at": 1762770000,
 "fields": ["status", "error", "checked_at", "expires_at", "consecutive_failures"],
 "urls": {"https://numpy.org/": [200, null, 1762760000, 1762846400, 0], ...}}
```

It is rebuilt by every maintenance run (every 10 minutes for now, see
`maintenanceEveryMinutes` in `src/config.ts`) and on the first cron run after
each deployment. It is served with an `ETag`, so send `If-None-Match` to get
a `304` when it hasn't changed. Until the first rebuild it returns `503`.

## Deploy

These steps assume `wrangler` is installed on your machine (for example
with `npm i -g wrangler`). The Worker has no runtime dependencies, so you
don't need `npm install` just to deploy. Wrangler bundles `src/index.ts`
directly. Run every command from the repository root.

### First-time bootstrap

1. **Log in** to Cloudflare. This opens a browser:

   ```console
   wrangler login
   ```

2. **Create the D1 database:**

   ```console
   wrangler d1 create link-check-proxy
   ```

   Copy the `database_id` it prints into `wrangler.toml`, replacing the
   `00000000-…` placeholder. Commit that change; the id is not a secret.

3. **Create the KV namespace** for the public snapshot:

   ```console
   wrangler kv namespace create SNAPSHOT
   ```

   Put the printed `id` into the `[[kv_namespaces]]` block of
   `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`, and commit it.
   Keep `binding = "SNAPSHOT"`, whatever binding name the command suggests.

4. **Create the tables:**

   ```console
   wrangler d1 migrations apply link-check-proxy --remote
   ```

5. **Deploy the Worker.** This also installs the every-minute cron trigger:

   ```console
   wrangler deploy
   ```

   It prints the URL, `https://link-check-proxy.<your-subdomain>.workers.dev`.
   If your account has no `workers.dev` subdomain yet, wrangler asks you to
   pick one.

6. **Set the admin token.** Generate a long random string, keep it in your
   password manager, and store it as a Worker secret:

   ```console
   openssl rand -base64 32
   wrangler secret put ADMIN_TOKEN     # paste the value when prompted
   ```

   Secrets take effect immediately; no redeploy is needed.

7. **Smoke test:**

   ```console
   export LCP_URL=https://link-check-proxy.<your-subdomain>.workers.dev
   export ADMIN_TOKEN=...                       # the value from step 5
   curl -s $LCP_URL/                            # {"service":"link-check-proxy",...}
   curl -s $LCP_URL/v1/check -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"urls": ["https://numpy.org/"]}'      # "unknown" the first time
   ```

   Within about a minute the cron job checks the URL. Repeat the last call
   and it should come back `"fresh"`. The [monitoring CLI](#monitoring) shows
   the same thing as it happens:

   ```console
   tools/lcp_status.py
   ``` To watch the ticks live:

   ```console
   wrangler tail          # one "tick {...}" log line per minute
   ```

### Redeploying

After pulling new changes:

```console
git pull
wrangler d1 migrations apply link-check-proxy --remote   # applies only new migrations; no-op if none
wrangler deploy
```

Apply migrations **before** deploying, so new code never runs against an
old schema.

For example, `0002_meta.sql` adds the table behind the monitoring view, and
`0003_host_index.sql` the per-host index the scheduler relies on.

**Upgrading to the snapshot version:** do step 3 of the bootstrap once
(create the KV namespace and put its id in `wrangler.toml`). `wrangler deploy`
fails while the placeholder id is still there.

Each deployment rebuilds the snapshot on the next cron run (via the
`version_metadata` binding); you don't need to wait for the schedule.

Other useful commands:

```console
wrangler deployments list            # deploy history
wrangler rollback                    # go back to the previous version (does not undo migrations)
wrangler secret put ADMIN_TOKEN      # rotate the admin token
wrangler d1 execute link-check-proxy --remote \
  --command "SELECT status, COUNT(*) FROM urls GROUP BY status"   # ad-hoc queries
```

## GitHub OIDC

Projects on GitHub Actions don't need a key. Instead they are added to
[`config/github-oidc.json`](config/github-oidc.json), which is bundled into
the Worker. Changes take effect on the next `wrangler deploy`.

```json
{"name": "Jupyter", "owner": "jupyter", "owner_id": 7388996}
{"name": "pydata-sphinx-theme", "repository": "pydata/pydata-sphinx-theme", "repository_id": 130237506}
```

- **Onboarding is a pull request.** The contributor adds an entry with the id
  set to `null`. The CI job `Check OIDC allowlist` (`tools/check_allowlist.py`)
  looks the name up on the GitHub API and prints the id to paste in, along
  with a corrected file. It fails until the ids are right. You can run it
  locally too: `python3 tools/check_allowlist.py`.
- **Matching uses numeric ids only.** Names can be renamed, or released and
  re-registered by someone else; ids can't. If CI reports an id/name
  mismatch, find out why before changing anything. Never "fix" it by
  copying the new id over.
- A repository entry takes precedence over its org's entry, so it can have
  its own quota.
- `new_url_quota_per_day` is optional (default 500).
- **Access by event:** `push`, `schedule`, `workflow_dispatch` and
  `merge_group` get full access. Every other event, including `pull_request`,
  is read-only: cached results only, nothing added. Fork PRs can't mint
  tokens at all and use the public snapshot.
- To revoke an entry, remove it in a PR and redeploy.

The client side needs `permissions: id-token: write` and a token minted with
`audience=link-check-proxy`. The consumer page (`/`) has a copy-paste example.

## Issuing API keys

Projects ask for a key by opening an issue with the "API key request" form
(`.github/ISSUE_TEMPLATE/api-key.yml`), which the root page links to. Create
the key as below, **send it to the requester privately** (never in the
issue), then close the issue. Use the project name as the key's `name` and
the issue URL as its `owner`, so every key can be traced back to its request:

```console
$ curl -s $LCP_URL/v1/admin/keys \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"name": "numpy", "owner": "https://github.com/carreau/link-check-proxy/issues/12", "quota": 500}'
{"id": "key_…", "key": "lcp_…", ...}     # the key is shown only once

$ curl -s $LCP_URL/v1/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN"
$ curl -s -X DELETE $LCP_URL/v1/admin/keys/key_… -H "Authorization: Bearer $ADMIN_TOKEN"
```

For an ongoing view of the service, see [Monitoring](#monitoring).

`quota` is the number of *new* URLs the key may add per day (default 500). Looking up URLs
that are already known is not limited by it.

## Monitoring

`tools/lcp_status.py` prints a compact status view, meant for `watch`. It
needs only Python 3, with no dependencies.

```console
export ADMIN_TOKEN=...      # see "Issuing API keys"; an admin API key works too
watch -n 30 -c tools/lcp_status.py --color
```

```
link-check-proxy  https://link-check-proxy.carreau.workers.dev  2026-11-10 10:15:33Z
URLs 1342  fresh 1080  stale 48  unknown 214  failing 12  4xx 31  (counts 21m ago)
queue: 230 never checked (180 due now), 34 due for refresh; draining takes ≥22m at ≤10/min
last tick 34s ago: picked 10, ok 8, rate-limited 1, deferred 1

UPCOMING  next batch of ≤10 in 41s
  next check    last checked  status     url
  overdue 5m    never         -          https://github.com/jupyter/notebook/issues/123
  in 45s        15m ago       503        https://docs.scipy.org/doc/scipy/reference/…

RECENT
  checked     next check    status     url
  34s ago     in 6h00       404        https://example.org/gone
  1m ago      in 15m        dns        https://nope.invalid/
```

It reads `/v1/admin/overview`, which only does reads with a fixed limit, so
polling it is cheap. The totals line is cached and recomputed by each
maintenance run (every 10 minutes for now, and after each deploy). Set `LCP_URL` to point it at another instance, use `-n` to
choose the number of rows (by default it fills the terminal), and `--json` to
get the raw data.

Avoid polling `/v1/admin/stats` in a loop: it scans the whole table on every
call, which uses up D1's free-tier read budget.

## Troubleshooting

**URLs stay overdue, and the overdue time grows.** Ticks are failing, or
being killed, before they save results. Check the watcher's `last tick …
ago` line (it turns red after 3 minutes), then look at the cron runs:

```console
wrangler tail link-check-proxy --format json \
  | jq -c 'select(.event.cron) | {outcome, cpu: .cpuTime, wall: .wallTime, logs: [.logs[].message], ex: .exceptions}'
```

An `outcome` of `exceededCpu` or `canceled`, or a `scheduled job failed`
log line, shows why. Ticks claim their URLs before fetching, so even a killed
tick no longer blocks the head of the queue: those URLs come back 10 minutes
later. The knobs (`checksPerTick`, `fetchBudgetPerTick`, `tickDeadlineMs`,
`fetchTimeoutMs`) are in `src/config.ts`.

**One host's URLs drain slowly.** That's by design: at most one check per
host per minute. The scheduler skips past such a host to keep other hosts
moving.

```console
wrangler d1 execute link-check-proxy --remote --command \
  "SELECT host, COUNT(*) n FROM urls WHERE next_check_at <= strftime('%s','now') GROUP BY host ORDER BY n DESC LIMIT 10"
wrangler d1 execute link-check-proxy --remote --command \
  "SELECT host, backoff_until - strftime('%s','now') AS seconds_left FROM hosts WHERE backoff_until > strftime('%s','now')"
```

## Development

```console
npm test            # unit + end-to-end tests (node:sqlite stands in for D1)
npm run typecheck
npm run migrate:local && npm run dev    # local Worker; needs workerd installed
```

## License

MIT
