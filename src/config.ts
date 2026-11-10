/** Tunables. All durations in seconds unless suffixed otherwise. */
export interface Config {
  maxUrlsPerRequest: number;
  maxUrlLength: number;

  /** Max URLs checked per cron tick. */
  checksPerTick: number;
  /** Max outbound fetches per tick (each redirect hop / HEAD→GET retry counts). */
  fetchBudgetPerTick: number;
  /** Max concurrent outbound fetches (Workers allow ~6 open connections). */
  fetchConcurrency: number;
  /** Max URLs of a single host checked per tick (≈ per minute). */
  maxPerHostPerTick: number;
  /** How many due rows to consider per tick, per query. */
  candidateLimit: number;
  /** Stop starting fetches this long into a tick (ms); the rest is deferred. */
  tickDeadlineMs: number;
  /** Picked URLs are pushed this far ahead before fetching, so a killed tick can't wedge the queue head. */
  claimSeconds: number;
  /** Run maintenance (stats + snapshot) on minutes divisible by this, instead of a checking tick. */
  maintenanceEveryMinutes: number;
  /** Rows per snapshot page (halved automatically if D1 says the value is too big). */
  snapshotPageSize: number;
  /** Spacing applied to new URLs of the same host inserted in one request. */
  newUrlHostSpacing: number;

  fetchTimeoutMs: number;
  maxRedirects: number;
  defaultRetryAfter: number;
  maxRetryAfter: number;
  userAgent: string;

  ttlOk: number;
  ttlRedirect: number;
  ttlClientError: number;
  failureBase: number;
  failureMax: number;
  /** Hot URLs are re-checked at this fraction of their TTL. */
  hotRefreshFraction: number;
  idleMaxInterval: number;
  dropAfter: number;
  /** Only rewrite last_requested_at when it is older than this (saves D1 writes). */
  requestTouchInterval: number;
  /** ± fraction of random jitter applied to intervals. */
  jitter: number;
}

export const REPO_URL = "https://github.com/carreau/link-check-proxy";
/** New URLs per day for API keys created without an explicit quota. */
export const DEFAULT_KEY_QUOTA = 500;

const HOUR = 3600;
const DAY = 24 * HOUR;

export const DEFAULT_CONFIG: Config = {
  maxUrlsPerRequest: 1000,
  maxUrlLength: 2048,

  // Sized for the free plan: ~50 subrequests per invocation (D1 calls may
  // count too) and a ~30 s budget for work after the handler returns.
  checksPerTick: 10,
  fetchBudgetPerTick: 30,
  fetchConcurrency: 6,
  maxPerHostPerTick: 1,
  candidateLimit: 200,
  tickDeadlineMs: 20_000,
  claimSeconds: 10 * 60,
  // Every 10 minutes while the service settles in; set back to 60 later.
  maintenanceEveryMinutes: 10,
  snapshotPageSize: 2000,
  newUrlHostSpacing: 60,

  fetchTimeoutMs: 5_000,
  maxRedirects: 10,
  defaultRetryAfter: HOUR,
  maxRetryAfter: DAY,
  userAgent: `link-check-proxy/0.1 (+${REPO_URL}; shared link-check cache for Jupyter/Scientific Python CI)`,

  ttlOk: DAY,
  ttlRedirect: DAY,
  ttlClientError: 6 * HOUR,
  failureBase: 15 * 60,
  failureMax: DAY,
  hotRefreshFraction: 0.8,
  idleMaxInterval: 7 * DAY,
  dropAfter: 30 * DAY,
  requestTouchInterval: 12 * HOUR,
  jitter: 0.1,
};
