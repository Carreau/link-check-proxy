/** One cron tick: pick due URLs, check them, write results. */
import { Budget, checkUrl, mapLimit, type FetchFn } from "./checker.js";
import type { Config } from "./config.js";
import { applyResult, pickBatch, type Rand, type ResultUpdate } from "./policy.js";
import type { Store } from "./store.js";

export interface TickReport {
  picked: number;
  results: number;
  rateLimited: number;
  deferred: number;
  dropped: number;
}

export async function runTick(opts: {
  store: Store;
  fetchFn: FetchFn;
  cfg: Config;
  nowMs: number;
  rand?: Rand;
  /** Also delete URLs nobody asked for in `dropAfter` (do this ~daily). */
  dropIdle?: boolean;
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
  let deferred = 0;
  picked.forEach((row, i) => {
    const o = outcomes[i]!;
    if (o.kind === "result") {
      updates.push(applyResult(row, o, now, cfg, rand));
    } else if (o.kind === "rate_limited") {
      const wait = Math.min(o.retryAfter ?? cfg.defaultRetryAfter, cfg.maxRetryAfter);
      const until = now + Math.max(wait, 60);
      backoffs.set(row.host, Math.max(backoffs.get(row.host) ?? 0, until));
    } else {
      deferred++; // still due; it will be picked again next tick
    }
  });

  await store.applyResults(updates);
  await store.backoffHosts([...backoffs].map(([host, until]) => ({ host, until })));

  const dropped = opts.dropIdle ? await store.dropIdle(now - cfg.dropAfter) : 0;

  return {
    picked: picked.length,
    results: updates.length,
    rateLimited: backoffs.size,
    deferred,
    dropped,
  };
}
