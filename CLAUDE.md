# link-check-proxy

Shared link-status cache for CI link checkers. Clients POST a list of URLs and
get cached statuses back immediately. URLs are checked politely in the
background.

- Full design: see `PROJECT.md`. Operator docs: `README.md` (deploy, keys,
  monitoring).
- **Every change must update the docs in the same change.** That means
  `PROJECT.md` for design or behavior, `README.md` for anything an operator
  runs or sees, and this file for project conventions.
- Layout: `src/` Worker (TypeScript), `migrations/` D1 schema (numbered,
  applied before deploy), `test/` vitest (node:sqlite D1 shim), `tools/`
  operator scripts (Python, stdlib only), `config/github-oidc.json` OIDC
  allowlist (bundled at deploy, changed by PR, ids checked in CI).
- Auth: API keys (admin-issued) or GitHub OIDC tokens from allowlisted
  orgs and repos, matched by **numeric id only**. `pull_request` OIDC runs are
  read-only. Default new-URL quota is 500/day.
- Deployed at https://link-check-proxy.carreau.workers.dev. The maintainer
  deploys with their own `wrangler`, outside this VM.
- `src/home.ts` is the public consumer page served at `/`. Keep it in sync
  with the API, the result states and the TTLs. Keys are requested through
  `.github/ISSUE_TEMPLATE/api-key.yml` and are never posted in issues.
- **All submitted URLs are public** (published in `/v1/snapshot.json`). Any
  user-facing text about submitting URLs must say so. Never add features
  that assume URLs are private.
- Free-plan sizing matters: a tick must stay under ~50 subrequests (fetches,
  and possibly D1 calls) and finish in ~20 s. Ticks claim picked URLs and
  persist per wave; keep it that way (see PROJECT.md §6.6).
- Never poll full-table queries. D1 free-tier read and write budgets shape
  the design (see PROJECT.md §5 and §6.5).
- Target: Cloudflare Workers + D1 + Cron Triggers, TypeScript.
- Keep the scheduling and classification logic in pure, platform-independent
  modules so it can be unit tested and ported.
- Keep it small: one community instance (Jupyter / Scientific Python). API
  keys are created by hand. No client integrations in this repo for now.
