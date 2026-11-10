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
  operator scripts (Python, stdlib only).
- Deployed at https://link-check-proxy.carreau.workers.dev. The maintainer
  deploys with their own `wrangler`, outside this VM.
- Never poll full-table queries. D1 free-tier read and write budgets shape
  the design (see PROJECT.md §5 and §6.5).
- Target: Cloudflare Workers + D1 + Cron Triggers, TypeScript.
- Keep the scheduling and classification logic in pure, platform-independent
  modules so it can be unit tested and ported.
- Keep it small: one community instance (Jupyter / Scientific Python). API
  keys are created by hand. No client integrations in this repo for now.
