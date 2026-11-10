# link-check-proxy

A shared link-status cache for CI link checkers in the Jupyter and Scientific
Python ecosystem. Instead of every CI run hitting every external URL, clients
ask this service, which answers right away from its cache and checks the URLs
itself in the background, slowly and politely.

For the design, see [PROJECT.md](PROJECT.md).

## API

All endpoints require `Authorization: Bearer <key>`.

```console
$ curl -s https://<worker>.workers.dev/v1/check \
    -H "Authorization: Bearer $LCP_KEY" \
    -d '{"urls": ["https://numpy.org/", "https://scipy.org/nope"]}'
{"results": {
  "https://numpy.org/":     {"state": "fresh", "status": 200, ...},
  "https://scipy.org/nope": {"state": "unknown", "status": null, ...}}}
```

`state` is `fresh`, `stale`, `unknown` or `rejected`. The client decides what
to do with each. See PROJECT.md §4.

## Deploy

```console
npm install
npx wrangler d1 create link-check-proxy   # put the id in wrangler.toml
npm run migrate:remote
npx wrangler secret put ADMIN_TOKEN        # any long random string
npm run deploy
```

## Issuing API keys

Keys are created by hand and given to projects directly:

```console
$ curl -s https://<worker>.workers.dev/v1/admin/keys \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"name": "numpy", "owner": "numpy maintainers", "quota": 5000}'
{"id": "key_…", "key": "lcp_…", ...}     # the key is shown only once

$ curl -s https://<worker>.workers.dev/v1/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN"
$ curl -s -X DELETE https://<worker>.workers.dev/v1/admin/keys/key_… -H "Authorization: Bearer $ADMIN_TOKEN"
$ curl -s https://<worker>.workers.dev/v1/admin/stats -H "Authorization: Bearer $ADMIN_TOKEN"
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
