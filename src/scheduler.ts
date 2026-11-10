/** One cron tick: pick due URLs, check them, write results. */
import { Budget, checkUrl, type FetchFn } from "./checker.js";
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
  /** Real clock for the tick deadline (tests pass a fake one). */
  clock?: () => number;
}): Promise<TickReport> {
  const { store, fetchFn, cfg } = opts;
  const rand = opts.rand ?? Math.random;
  const clock = opts.clock ?? Date.now;
  const now = Math.floor(opts.nowMs / 1000);
  const budget = new Budget(cfg.fetchBudgetPerTick, clock() + cfg.tickDeadlineMs, clock);

  // 1. Pick. If one host's backlog filled the window, look again past it.
  const first = await store.dueCandidates(now, cfg.candidateLimit);
  let candidates = first.rows;
  let backoff = await store.hostsInBackoff(uniq(candidates.map((c) => c.host)), now);
  let picked = pickBatch(candidates, new Set(backoff.keys()), cfg);
  if (first.full && picked.length < cfg.checksPerTick) {
    const seenHosts = uniq(candidates.map((c) => c.host));
    const more = await store.dueExcludingHosts(now, seenHosts, cfg.candidateLimit);
    const moreBackoff = await store.hostsInBackoff(uniq(more.map((c) => c.host)), now);
    backoff = new Map([...backoff, ...moreBackoff]);
    candidates = [...candidates, ...more];
    picked = pickBatch(candidates, new Set(backoff.keys()), cfg);
  }

  // 2. Claim: push picked URLs ahead, so if this invocation is killed
  //    mid-way they don't stay at the head of the queue forever.
  await store.setNextCheck(
    picked.map((r) => r.url),
    now + cfg.claimSeconds,
  );

  // 3. Check in waves of `fetchConcurrency`, persisting after each wave so a
  //    killed tick loses at most one wave of results.
  const activity: RecentCheck[] = [];
  const backoffs = new Map<string, number>();
  let results = 0;
  let deferred = 0;
  for (let i = 0; i < picked.length; i += cfg.fetchConcurrency) {
    const wave = picked.slice(i, i + cfg.fetchConcurrency);
    const outcomes = await Promise.all(
      wave.map((row) =>
        checkUrl(row.url, fetchFn, budget, cfg).catch(
          () => ({ kind: "result", status: null, error: "other", finalUrl: null }) as const,
        ),
      ),
    );
    const updates: ResultUpdate[] = [];
    const release: string[] = [];
    wave.forEach((row, j) => {
      const o = outcomes[j]!;
      if (o.kind === "result") {
        const u = applyResult(row, o, now, cfg, rand);
        updates.push(u);
        activity.push({ url: row.url, at: now, kind: "result", status: u.status, error: u.error, next_check_at: u.next_check_at });
      } else if (o.kind === "rate_limited") {
        const wait = Math.min(o.retryAfter ?? cfg.defaultRetryAfter, cfg.maxRetryAfter);
        const until = now + Math.max(wait, 60);
        // Back off the host that said 429 and the URL's own host (they
        // differ after a redirect); the URL itself is pushed by either.
        for (const h of uniq([o.host, row.host])) backoffs.set(h, Math.max(backoffs.get(h) ?? 0, until));
        release.push(row.url); // undo the claim so backoffHosts spreads it with the rest
        activity.push({ url: row.url, at: now, kind: "rate_limited", status: 429, error: null, next_check_at: until });
      } else {
        deferred++;
        release.push(row.url); // undo the claim: due again next tick
        activity.push({ url: row.url, at: now, kind: "deferred", status: null, error: null, next_check_at: now });
      }
    });
    await store.applyResults(updates);
    await store.setNextCheck(release, now);
    results += updates.length;
  }
  await store.backoffHosts(
    [...backoffs].map(([host, until]) => ({ host, until })),
    cfg.newUrlHostSpacing,
  );

  const report: TickReport = {
    picked: picked.length,
    results,
    rateLimited: backoffs.size,
    deferred,
  };
  await recordActivity(store, now, report, activity);
  return report;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
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
    const built = await buildSnapshot(store, now, cfg.snapshotPageSize);
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
  // Until the first maintenance run, give the overview some numbers.
  if (!(await store.getMeta("stats"))) {
    await store.setMeta("stats", await store.stats(now), now);
  }
}

/**
 * What the every-minute cron does. Maintenance replaces checking on minutes
 * divisible by `maintenanceEveryMinutes`, and also on the first run of a
 * newly deployed version (so a redeploy rebuilds the snapshot right away).
 */
export async function runScheduled(opts: {
  store: Store;
  cfg: Config;
  nowMs: number;
  fetchFn: FetchFn;
  blobs?: BlobStore;
  /** Deployed version id (version_metadata binding), if available. */
  versionId?: string;
}): Promise<{ kind: "maintenance"; report: MaintenanceReport; reason: string } | { kind: "tick"; report: TickReport }> {
  const { store, cfg } = opts;
  const when = new Date(opts.nowMs);
  let reason = when.getUTCMinutes() % cfg.maintenanceEveryMinutes === 0 ? "schedule" : "";
  if (!reason && opts.versionId) {
    const seen = await store.getMeta<string>("deployed_version");
    if (seen?.value !== opts.versionId) reason = "new deployment";
  }
  if (reason) {
    const report = await runMaintenance({
      store,
      cfg,
      nowMs: opts.nowMs,
      blobs: opts.blobs,
      // Daily, at 03:00 UTC (only on a scheduled maintenance minute).
      dropIdle: reason === "schedule" && when.getUTCHours() === 3 && when.getUTCMinutes() === 0,
    });
    if (opts.versionId) await store.setMeta("deployed_version", opts.versionId, Math.floor(opts.nowMs / 1000));
    return { kind: "maintenance", report, reason };
  }
  return { kind: "tick", report: await runTick({ store, fetchFn: opts.fetchFn, cfg, nowMs: opts.nowMs }) };
}
