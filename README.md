# link-check-proxy

A shared link-status cache for CI link checkers in the Jupyter and Scientific
Python ecosystem. Instead of every CI run hitting every external URL, clients
ask this service, which answers right away from its cache and checks the URLs
itself in the background, slowly and politely.

For the design, see [PROJECT.md](PROJECT.md). Using the service from your
project's CI? Open https://link-check-proxy.carreau.workers.dev in a browser
for consumer instructions, or
[request an API key](https://github.com/carreau/link-check-proxy/issues/new?template=api-key.yml).

## API

All `/v1/*` endpoints require `Authorization: Bearer <key>`. The root `/` is
public. Browsers get a page for consumers (from `src/home.ts`); API clients
get a small JSON blob.

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

3. **Create the tables:**

   ```console
   wrangler d1 migrations apply link-check-proxy --remote
   ```

4. **Deploy the Worker.** This also installs the every-minute cron trigger:

   ```console
   wrangler deploy
   ```

   It prints the URL, `https://link-check-proxy.<your-subdomain>.workers.dev`.
   If your account has no `workers.dev` subdomain yet, wrangler asks you to
   pick one.

5. **Set the admin token.** Generate a long random string, keep it in your
   password manager, and store it as a Worker secret:

   ```console
   openssl rand -base64 32
   wrangler secret put ADMIN_TOKEN     # paste the value when prompted
   ```

   Secrets take effect immediately; no redeploy is needed.

6. **Smoke test:**

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
old schema. For example, `0002_meta.sql` adds the table behind the monitoring
view. If you deploy without it, each tick still saves its results but then
fails with `no such table: meta`.

Other useful commands:

```console
wrangler deployments list            # deploy history
wrangler rollback                    # go back to the previous version (does not undo migrations)
wrangler secret put ADMIN_TOKEN      # rotate the admin token
wrangler d1 execute link-check-proxy --remote \
  --command "SELECT status, COUNT(*) FROM urls GROUP BY status"   # ad-hoc queries
```

## Issuing API keys

Projects ask for a key by opening an issue with the "API key request" form
(`.github/ISSUE_TEMPLATE/api-key.yml`), which the root page links to. Create
the key as below, **send it to the requester privately** (never in the
issue), then close the issue. Use the project name as the key's `name` and
the issue URL as its `owner`, so every key can be traced back to its request:

```console
$ curl -s $LCP_URL/v1/admin/keys \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"name": "numpy", "owner": "https://github.com/carreau/link-check-proxy/issues/12", "quota": 5000}'
{"id": "key_…", "key": "lcp_…", ...}     # the key is shown only once

$ curl -s $LCP_URL/v1/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN"
$ curl -s -X DELETE $LCP_URL/v1/admin/keys/key_… -H "Authorization: Bearer $ADMIN_TOKEN"
```

For an ongoing view of the service, see [Monitoring](#monitoring).

`quota` is the number of *new* URLs the key may add per day. Looking up URLs
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
due now 214   last tick 34s ago: picked 20, ok 18, rate-limited 1, deferred 1

UPCOMING  next check  last checked  status     url
  due 5m      never         -          https://github.com/jupyter/notebook/issues/123
  in 45s      15m ago       503        https://docs.scipy.org/doc/scipy/reference/…
RECENT    checked     next check    status     url
  34s ago     in 6h00       404        https://example.org/gone
  1m ago      in 15m        dns        https://nope.invalid/
```

It reads `/v1/admin/overview`, which only does reads with a fixed limit, so
polling it is cheap. The totals line is cached and recomputed by the cron job
once an hour. Set `LCP_URL` to point it at another instance, use `-n` to
choose the number of rows (by default it fills the terminal), and `--json` to
get the raw data.

Avoid polling `/v1/admin/stats` in a loop: it scans the whole table on every
call, which uses up D1's free-tier read budget.

## Development

```console
npm test            # unit + end-to-end tests (node:sqlite stands in for D1)
npm run typecheck
npm run migrate:local && npm run dev    # local Worker; needs workerd installed
```

## License

MIT
