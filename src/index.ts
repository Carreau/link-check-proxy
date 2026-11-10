import { handleRequest } from "./api.js";
import { DEFAULT_CONFIG } from "./config.js";
import rawAllowlist from "../config/github-oidc.json";
import { JwksCache, validateAllowlist, verifyGithubToken, type Allowlist } from "./oidc.js";
import { runScheduled } from "./scheduler.js";
import { SNAPSHOT_KEY, type BlobStore } from "./snapshot.js";
import { Store, type Db } from "./store.js";

export interface Env {
  DB: D1Database;
  /** Public snapshot storage. Optional: without it, no snapshot is built. */
  SNAPSHOT?: KVNamespace;
  ADMIN_TOKEN?: string;
  /** [version_metadata] binding: lets the cron notice a new deployment. */
  CF_VERSION_METADATA?: { id: string };
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

  async scheduled(controller, env): Promise<void> {
    // Await (not just waitUntil) so the invocation lives as long as the job,
    // and rethrow so failures show as failed runs in Cloudflare's dashboard.
    try {
      const r = await runScheduled({
        store: store(env),
        cfg: DEFAULT_CONFIG,
        nowMs: controller.scheduledTime,
        fetchFn: (input, init) => fetch(input, init),
        blobs: blobs(env),
        versionId: env.CF_VERSION_METADATA?.id,
      });
      if (r.kind === "tick") console.log("tick", JSON.stringify(r.report));
      else console.log("maintenance", r.reason, JSON.stringify({ ...r.report, stats: undefined }));
    } catch (e) {
      console.error("scheduled job failed", e);
      throw e;
    }
  },
} satisfies ExportedHandler<Env>;
