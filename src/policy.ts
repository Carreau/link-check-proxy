/** Pure scheduling policy: TTLs, backoff, hot/idle handling, public state. */
import type { Config } from "./config.js";
import type { ErrorKind, PublicResult, UrlRow } from "./types.js";

export type Rand = () => number;

export function isFailure(status: number | null, error: ErrorKind | null): boolean {
  // A bot challenge is the site's policy, not an outage: retrying quickly
  // just hits the sites that already block us. Use the status's TTL (403: 6 h).
  if (error === "challenged") return status === null || status >= 500;
  if (error !== null) return true;
  return status === null || status >= 500;
}

/** Base TTL for a non-failure result. */
export function baseTtl(status: number, cfg: Config): number {
  if (status >= 200 && status < 300) return cfg.ttlOk;
  if (status >= 300 && status < 400) return cfg.ttlRedirect;
  return cfg.ttlClientError;
}

export function failureInterval(failures: number, cfg: Config): number {
  const n = Math.max(1, failures);
  return Math.min(cfg.failureBase * 2 ** (n - 1), cfg.failureMax);
}

export function jittered(seconds: number, cfg: Config, rand: Rand): number {
  const f = 1 - cfg.jitter + 2 * cfg.jitter * rand();
  return Math.max(1, Math.round(seconds * f));
}

/**
 * A URL is "hot" if it was requested since its last check. last_requested_at
 * is only rewritten every `requestTouchInterval`, so allow that much slack.
 * Never-checked URLs are hot by definition (someone just asked for them).
 */
export function isHot(row: UrlRow, cfg: Config): boolean {
  if (row.checked_at === null) return true;
  return row.last_requested_at >= row.checked_at - cfg.requestTouchInterval;
}

export type ResultUpdate = Pick<
  UrlRow,
  | "url"
  | "status"
  | "error"
  | "final_url"
  | "checked_at"
  | "expires_at"
  | "next_check_at"
  | "consecutive_failures"
  | "idle_level"
>;

/** Compute the new row fields after a completed check. */
export function applyResult(
  row: UrlRow,
  result: { status: number | null; error: ErrorKind | null; finalUrl: string | null },
  now: number,
  cfg: Config,
  rand: Rand,
): ResultUpdate {
  const failed = isFailure(result.status, result.error);
  const failures = failed ? row.consecutive_failures + 1 : 0;
  // A non-failure always has a status (isFailure guarantees it).
  const ttl = failed ? failureInterval(failures, cfg) : baseTtl(result.status!, cfg);

  let interval: number;
  let idle: number;
  if (isHot(row, cfg)) {
    idle = 0;
    interval = failed ? ttl : ttl * cfg.hotRefreshFraction;
  } else {
    idle = row.idle_level + 1;
    interval = Math.min(ttl * 2 ** idle, cfg.idleMaxInterval);
  }

  return {
    url: row.url,
    status: result.status,
    error: result.error,
    final_url: result.finalUrl,
    checked_at: now,
    expires_at: now + ttl,
    next_check_at: now + jittered(interval, cfg, rand),
    consecutive_failures: failures,
    idle_level: idle,
  };
}

export function publicResult(row: UrlRow | undefined, now: number): PublicResult {
  if (!row || row.checked_at === null) {
    return {
      state: "unknown",
      status: null,
      error: null,
      final_url: null,
      checked_at: null,
      consecutive_failures: 0,
    };
  }
  return {
    state: row.expires_at !== null && now < row.expires_at ? "fresh" : "stale",
    status: row.status,
    error: row.error,
    final_url: row.final_url,
    checked_at: new Date(row.checked_at * 1000).toISOString(),
    consecutive_failures: row.consecutive_failures,
  };
}

export function rejectedResult(reason: string): PublicResult {
  return {
    state: "rejected",
    status: null,
    error: null,
    final_url: null,
    checked_at: null,
    consecutive_failures: 0,
    reason,
  };
}

/**
 * Pick which due candidates to check this tick. Candidates are expected in
 * priority order (never-checked first, then by next_check_at).
 */
export function pickBatch(
  candidates: UrlRow[],
  hostsInBackoff: Set<string>,
  cfg: Config,
): UrlRow[] {
  const picked: UrlRow[] = [];
  const seen = new Set<string>();
  const perHost = new Map<string, number>();
  for (const row of candidates) {
    if (picked.length >= cfg.checksPerTick) break;
    if (seen.has(row.url) || hostsInBackoff.has(row.host)) continue;
    const n = perHost.get(row.host) ?? 0;
    if (n >= cfg.maxPerHostPerTick) continue;
    seen.add(row.url);
    perHost.set(row.host, n + 1);
    picked.push(row);
  }
  return picked;
}

/** Parse a Retry-After header (seconds or HTTP date) into seconds from now. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((t - nowMs) / 1000));
}
