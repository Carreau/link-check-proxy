export type ErrorKind =
  | "dns"
  | "connect"
  | "tls"
  | "timeout"
  | "too_many_redirects"
  | "invalid_url"
  | "blocked"
  | "challenged"
  | "other";

/** A row of the `urls` table. Times are epoch seconds. */
export interface UrlRow {
  url: string;
  host: string;
  status: number | null;
  error: ErrorKind | null;
  final_url: string | null;
  checked_at: number | null;
  expires_at: number | null;
  next_check_at: number;
  first_seen_at: number;
  last_requested_at: number;
  request_count: number;
  consecutive_failures: number;
  idle_level: number;
}

/** What the checker observed for one URL. */
export type CheckOutcome =
  | {
      kind: "result";
      status: number | null;
      error: ErrorKind | null;
      finalUrl: string | null;
    }
  /** Host said 429; back off the whole host, record nothing for the URL. */
  | { kind: "rate_limited"; retryAfter: number | null; host: string }
  /** Fetch budget ran out mid-check; try again next tick. */
  | { kind: "deferred" };

export type PublicState = "fresh" | "stale" | "unknown" | "rejected";

export interface PublicResult {
  state: PublicState;
  status: number | null;
  error: ErrorKind | null;
  final_url: string | null;
  checked_at: string | null;
  consecutive_failures: number;
  reason?: string;
}
