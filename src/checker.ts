/** Outbound checking: HEAD→GET fallback, manual redirects, error classification. */
import type { Config } from "./config.js";
import { parseRetryAfter } from "./policy.js";
import type { CheckOutcome, ErrorKind } from "./types.js";
import { normalizeUrl } from "./url.js";

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Shared per-tick limits: a cap on outbound fetches (Workers subrequest
 * limit) and an optional wall-clock deadline (work after the handler returns
 * is time-limited). Work that hits either is deferred, not recorded.
 */
export class Budget {
  constructor(
    private remaining: number,
    private deadlineMs = Infinity,
    private clock: () => number = Date.now,
  ) {}
  take(): boolean {
    if (this.remaining <= 0 || this.clock() >= this.deadlineMs) return false;
    this.remaining -= 1;
    return true;
  }
  get left(): number {
    return this.remaining;
  }
  /** Milliseconds until the deadline (Infinity if none). */
  timeLeft(): number {
    return this.deadlineMs - this.clock();
  }
}

class BudgetExhausted extends Error {}

/** Statuses for which a HEAD answer is not trusted and we retry with GET. */
const HEAD_FALLBACK = new Set([403, 404, 405, 501]);
/**
 * Errors worth retrying with GET (a server that mishandles HEAD). Timeouts,
 * DNS and TLS failures would just fail again and double the wall time.
 */
const GET_RETRY_ERRORS = new Set<ErrorKind>(["connect", "other"]);

type HopResult =
  | { kind: "response"; status: number; finalUrl: string; retryAfter: number | null; challenged: boolean }
  | { kind: "error"; error: ErrorKind; finalUrl: string };

export async function checkUrl(
  url: string,
  fetchFn: FetchFn,
  budget: Budget,
  cfg: Config,
  nowMs: () => number = Date.now,
): Promise<CheckOutcome> {
  try {
    let r = await followChain(url, "HEAD", fetchFn, budget, cfg);
    if (
      (r.kind === "response" && HEAD_FALLBACK.has(r.status)) ||
      (r.kind === "error" && GET_RETRY_ERRORS.has(r.error))
    ) {
      r = await followChain(url, "GET", fetchFn, budget, cfg);
    }
    if (r.kind === "error") {
      return { kind: "result", status: null, error: r.error, finalUrl: r.finalUrl };
    }
    if (r.status === 429) {
      // Back off whoever answered 429, which may be a redirect target.
      return { kind: "rate_limited", retryAfter: r.retryAfter, host: new URL(r.finalUrl).hostname };
    }
    return {
      kind: "result",
      status: r.status,
      error: r.challenged ? "challenged" : null,
      finalUrl: r.finalUrl,
    };
  } catch (e) {
    if (e instanceof BudgetExhausted) return { kind: "deferred" };
    throw e;
  }

  async function followChain(
    start: string,
    method: "HEAD" | "GET",
    fetchFn: FetchFn,
    budget: Budget,
    cfg: Config,
  ): Promise<HopResult> {
    let current = start;
    for (let hop = 0; hop <= cfg.maxRedirects; hop++) {
      if (!budget.take()) throw new BudgetExhausted();
      // Never run past the tick deadline: cut the timeout short, and treat a
      // cut-short timeout as "deferred", not as the site timing out.
      const cutShort = budget.timeLeft() < cfg.fetchTimeoutMs;
      const timeoutMs = Math.max(1, Math.min(cfg.fetchTimeoutMs, budget.timeLeft()));
      let res: Response;
      try {
        res = await fetchFn(current, {
          method,
          redirect: "manual",
          headers: { "user-agent": cfg.userAgent, accept: "*/*" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const error = classifyError(e);
        if (error === "timeout" && cutShort) throw new BudgetExhausted();
        return { kind: "error", error, finalUrl: current };
      }
      // Never read bodies in v1; free the connection.
      res.body?.cancel().catch(() => {});

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { kind: "error", error: "invalid_url", finalUrl: current };
        }
        const n = normalizeUrl(next, cfg.maxUrlLength);
        if (!n.ok) {
          return {
            kind: "error",
            error: n.reason === "private_address" ? "blocked" : "invalid_url",
            finalUrl: next,
          };
        }
        current = n.url;
        continue;
      }
      return {
        kind: "response",
        status: res.status,
        finalUrl: current,
        retryAfter: parseRetryAfter(res.headers.get("retry-after"), nowMs()),
        challenged: isChallenge(res),
      };
    }
    return { kind: "error", error: "too_many_redirects", finalUrl: current };
  }
}

/** Cloudflare (and similar) bot challenges: the URL is probably fine for humans. */
export function isChallenge(res: Response): boolean {
  if (res.headers.get("cf-mitigated") === "challenge") return true;
  return false;
}

export function classifyError(e: unknown): ErrorKind {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const name = err?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const text = `${err?.message ?? ""} ${err?.cause?.code ?? ""} ${err?.cause?.message ?? ""}`.toLowerCase();
  if (/enotfound|eai_again|dns|getaddrinfo|name not resolved/.test(text)) return "dns";
  if (/cert|tls|ssl|handshake/.test(text)) return "tls";
  if (/timed? ?out|etimedout/.test(text)) return "timeout";
  if (/econnrefused|econnreset|connect|network|socket|ehostunreach/.test(text)) return "connect";
  return "other";
}

/** Run tasks with bounded concurrency, preserving order of results. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}
