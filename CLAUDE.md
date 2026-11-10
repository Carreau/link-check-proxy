# link-check-proxy

Shared link-status cache for CI link checkers. Clients POST a list of URLs and
get cached statuses back immediately. URLs are checked politely in the
background.

- Full design: see `PROJECT.md`. Keep it up to date when the design changes.
- Target: Cloudflare Workers + D1 + Cron Triggers, TypeScript.
- Keep the scheduling and classification logic in pure, platform-independent
  modules so it can be unit tested and ported.
- Keep it small: one community instance (Jupyter / Scientific Python). API
  keys are created by hand. No client integrations in this repo for now.
