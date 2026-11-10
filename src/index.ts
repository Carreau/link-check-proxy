import { handleRequest } from "./api.js";
import { DEFAULT_CONFIG } from "./config.js";
import rawAllowlist from "../config/github-oidc.json";
import { JwksCache, validateAllowlist, verifyGithubToken, type Allowlist } from "./oidc.js";
import { runMaintenance, runTick } from "./scheduler.js";
import { SNAPSHOT_KEY, type BlobStore } from "./snapshot.js";
import { Store, type Db } from "./store.js";

export interface Env {
  DB: D1Database;
  /** Public snapshot storage. Optional: without it, no snapshot is built. */
  SNAPSHOT?: KVNamespace;
  ADMIN_TOKEN?: string;
}

const store = (env: Env) => new Store(env.DB as unknown as Db);
const blobs = (env: Env): BlobStore | undefined =>
  env.SNAPSHOT && {
    get: (k) => env.SNAPSHOT!.get(k),
    put: (k, v) => env.SNAPSHOT!.put(k, v),
  };

// OIDC allowlist, bundled at deploy time. CI rejects invalid files; should
// one slip through, entries without numeric ids simply never match.
const allowlist = rawAllowlist as Allowlist;
const allowlistErrors = validateAllowlist(allowlist);
if (allowlistErrors.length) console.error("config/github-oidc.json problems", allowlistErrors);
const jwks = new JwksCache((url) => fetch(url));

// Per-isolate memory cache of the snapshot. The Cache API is not available
// on workers.dev, and this keeps KV reads (100k/day on free) low.
const SNAPSHOT_MEMO_MS = 5 * 60 * 1000;
let memo: { body: string | null; at: number } | null = null;

async function cachedSnapshot(env: Env): Promise<string | null> {
  const now = Date.now();
  if (memo && now - memo.at < SNAPSHOT_MEMO_MS) return memo.body;
  const body = env.SNAPSHOT ? await env.SNAPSHOT.get(SNAPSHOT_KEY) : null;
  memo = { body, at: now };
  return body;
}

export default {
  async fetch(req, env): Promise<Response> {
    return handleRequest(req, {
      store: store(env),
      cfg: DEFAULT_CONFIG,
      nowMs: Date.now,
      adminToken: env.ADMIN_TOKEN,
      snapshot: () => cachedSnapshot(env),
      oidc: {
        verify: (token) => verifyGithubToken(token, jwks.lookup, Math.floor(Date.now() / 1000)),
        allowlist,
      },
    });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    const when = new Date(controller.scheduledTime);
    const common = { store: store(env), cfg: DEFAULT_CONFIG, nowMs: controller.scheduledTime };
    // Minute 0 of each hour is housekeeping instead of checking: stats,
    // public snapshot, and (at 03:00 UTC) dropping long-unrequested URLs.
    const job =
      when.getUTCMinutes() === 0
        ? runMaintenance({
            ...common,
            blobs: blobs(env),
            dropIdle: when.getUTCHours() === 3,
          }).then((r) => console.log("maintenance", JSON.stringify({ ...r, stats: undefined })))
        : runTick({ ...common, fetchFn: (input, init) => fetch(input, init) }).then((r) =>
            console.log("tick", JSON.stringify(r)),
          );
    ctx.waitUntil(job.catch((e) => console.error("scheduled job failed", e)));
  },
} satisfies ExportedHandler<Env>;
