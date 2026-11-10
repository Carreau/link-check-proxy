/** One cron tick: pick due URLs, check them, write results. */
import { Budget, checkUrl, mapLimit, type FetchFn } from "./checker.js";
import type { Config } from "./config.js";
import { applyResult, pickBatch, type Rand, type ResultUpdate } from "./policy.js";
import { buildSnapshot, SNAPSHOT_KEY, type BlobStore, type SnapshotInfo } from "./snapshot.js";
import type { Store } from "./store.js";

export interface TickReport {
  picked: number;
  results: number;
  rateLimited: number;
  deferred: number;
}

export async function runTick(opts: {
  store: Store;
  fetchFn: FetchFn;
  cfg: Config;
  nowMs: number;
  rand?: Rand;
}): Promise<TickReport> {
  const { store, fetchFn, cfg } = opts;
  const rand = opts.rand ?? Math.random;
  const now = Math.floor(opts.nowMs / 1000);

  const candidates = await store.dueCandidates(now, cfg.candidateLimit);
  const backoff = await store.hostsInBackoff([...new Set(candidates.map((c) => c.host))], now);
  const picked = pickBatch(candidates, backoff, cfg);

  const budget = new Budget(cfg.fetchBudgetPerTick);
  const outcomes = await mapLimit(picked, cfg.fetchConcurrency, (row) =>
    checkUrl(row.url, fetchFn, budget, cfg).catch(
      () => ({ kind: "result", status: null, error: "other", finalUrl: null }) as const,
    ),
  );

  const updates: ResultUpdate[] = [];
  const backoffs = new Map<string, number>();
  const activity: RecentCheck[] = [];
  let deferred = 0;
  picked.forEach((row, i) => {
    const o = outcomes[i]!;
    if (o.kind === "result") {
      const u = applyResult(row, o, now, cfg, rand);
      updates.push(u);
      activity.push({
        url: row.url,
        at: now,
        kind: "result",
        status: u.status,
        error: u.error,
        next_check_at: u.next_check_at,
      });
    } else if (o.kind === "rate_limited") {
      const wait = Math.min(o.retryAfter ?? cfg.defaultRetryAfter, cfg.maxRetryAfter);
      const until = now + Math.max(wait, 60);
      backoffs.set(row.host, Math.max(backoffs.get(row.host) ?? 0, until));
      activity.push({ url: row.url, at: now, kind: "rate_limited", status: 429, error: null, next_check_at: until });
    } else {
      deferred++; // still due; it will be picked again next tick
      activity.push({ url: row.url, at: now, kind: "deferred", status: null, error: null, next_check_at: null });
    }
  });

  await store.applyResults(updates);
  await store.backoffHosts([...backoffs].map(([host, until]) => ({ host, until })));

  const report: TickReport = {
    picked: picked.length,
    results: updates.length,
    rateLimited: backoffs.size,
    deferred,
  };
  await recordActivity(store, now, report, activity);
  return report;
}

export interface MaintenanceReport {
  dropped: number;
  stats: Record<string, number>;
  snapshot: SnapshotInfo | null;
}

/**
 * Hourly housekeeping, run *instead of* a checking tick so its full-table
 * scans don't compete with checks for the per-invocation query budget:
 * drop idle URLs (when asked, ~daily), recompute stats, rebuild the public
 * snapshot.
 */
export async function runMaintenance(opts: {
  store: Store;
  cfg: Config;
  nowMs: number;
  blobs?: BlobStore;
  dropIdle?: boolean;
}): Promise<MaintenanceReport> {
  const { store, cfg } = opts;
  const now = Math.floor(opts.nowMs / 1000);
  const dropped = opts.dropIdle ? await store.dropIdle(now - cfg.dropAfter) : 0;
  const stats = await store.stats(now);
  await store.setMeta("stats", stats, now);
  let snapshot: SnapshotInfo | null = null;
  if (opts.blobs) {
    const built = await buildSnapshot(store, now);
    await opts.blobs.put(SNAPSHOT_KEY, built.body);
    await store.setMeta("snapshot", built.info, now);
    snapshot = built.info;
  }
  return { dropped, stats, snapshot };
}

/** One entry of the recent-checks log kept in `meta` for the admin overview. */
export interface RecentCheck {
  url: string;
  at: number;
  kind: "result" | "rate_limited" | "deferred";
  status: number | null;
  error: string | null;
  next_check_at: number | null;
}

export const RECENT_LOG_SIZE = 100;

async function recordActivity(
  store: Store,
  now: number,
  report: TickReport,
  activity: RecentCheck[],
): Promise<void> {
  await store.setMeta("last_tick", report, now);
  if (activity.length > 0) {
    const prev = (await store.getMeta<RecentCheck[]>("recent"))?.value ?? [];
    await store.setMeta("recent", [...activity, ...prev].slice(0, RECENT_LOG_SIZE), now);
  }
  // Until the first hourly maintenance run, give the overview some numbers.
  if (!(await store.getMeta("stats"))) {
    await store.setMeta("stats", await store.stats(now), now);
  }
}
