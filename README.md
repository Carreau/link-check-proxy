# link-check-proxy

A shared link-status cache for CI link checkers in the Jupyter and Scientific
Python ecosystem. Instead of every CI run hitting every external URL, clients
ask this service, which answers right away from its cache and checks the URLs
itself in the background, slowly and politely.

For the design, see [PROJECT.md](PROJECT.md).

## API

All endpoints require `Authorization: Bearer <key>`.

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
   curl -s $LCP_URL/v1/admin/stats -H "Authorization: Bearer $ADMIN_TOKEN"
   curl -s $LCP_URL/v1/check -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"urls": ["https://numpy.org/"]}'      # "unknown" the first time
   ```

   Within about a minute the cron job checks the URL. Repeat the last call
   and it should come back `"fresh"`. To watch the ticks live:

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

Other useful commands:

```console
wrangler deployments list            # deploy history
wrangler rollback                    # go back to the previous version (does not undo migrations)
wrangler secret put ADMIN_TOKEN      # rotate the admin token
wrangler d1 execute link-check-proxy --remote \
  --command "SELECT status, COUNT(*) FROM urls GROUP BY status"   # ad-hoc queries
```

## Issuing API keys

Keys are created by hand and given to projects directly:

```console
$ curl -s $LCP_URL/v1/admin/keys \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"name": "numpy", "owner": "numpy maintainers", "quota": 5000}'
{"id": "key_…", "key": "lcp_…", ...}     # the key is shown only once

$ curl -s $LCP_URL/v1/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN"
$ curl -s -X DELETE $LCP_URL/v1/admin/keys/key_… -H "Authorization: Bearer $ADMIN_TOKEN"
$ curl -s $LCP_URL/v1/admin/stats -H "Authorization: Bearer $ADMIN_TOKEN"
```

`quota` is the number of *new* URLs the key may add per day. Looking up URLs
that are already known is not limited by it.

## Development

```console
npm test            # unit + end-to-end tests (node:sqlite stands in for D1)
npm run typecheck
npm run migrate:local && npm run dev    # local Worker; needs workerd installed
```

## License

MIT
