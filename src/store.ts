/**
 * Storage over a D1-compatible database.
 *
 * D1 (free tier) limits queries per invocation and bound parameters per
 * statement (100), so every bulk operation passes its rows as ONE JSON
 * parameter and expands it with json_each(). Every method is one query.
 */
import type { ResultUpdate } from "./policy.js";
import type { UrlRow } from "./types.js";

/** The subset of D1Database we use (lets tests plug in node:sqlite). */
export interface Db {
  prepare(sql: string): Stmt;
  batch(stmts: Stmt[]): Promise<unknown[]>;
}
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface ApiKeyRow {
  id: string;
  key_hash: string;
  name: string;
  owner: string | null;
  is_admin: number;
  new_url_quota_per_day: number;
  created_at: number;
  revoked_at: number | null;
}

export interface NewUrl {
  url: string;
  host: string;
  next_check_at: number;
}

const URL_COLS = `url, host, status, error, final_url, checked_at, expires_at, next_check_at,
  first_seen_at, last_requested_at, request_count, consecutive_failures, idle_level`;

export class Store {
  constructor(private db: Db) {}

  // ---- URLs (API side) ----

  async lookup(urls: string[]): Promise<Map<string, UrlRow>> {
    if (urls.length === 0) return new Map();
    const { results } = await this.db
      .prepare(`SELECT ${URL_COLS} FROM urls WHERE url IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(urls))
      .all<UrlRow>();
    return new Map(results.map((r) => [r.url, r]));
  }

  /** Insert URLs not yet known; returns how many were actually inserted. */
  async insertNew(rows: NewUrl[], now: number): Promise<number> {
    if (rows.length === 0) return 0;
    const r = await this.db
      .prepare(
        `INSERT OR IGNORE INTO urls (url, host, next_check_at, first_seen_at, last_requested_at, request_count)
         SELECT json_extract(value, '$.url'), json_extract(value, '$.host'),
                json_extract(value, '$.next_check_at'), ?1, ?1, 1
         FROM json_each(?2)`,
      )
      .bind(now, JSON.stringify(rows))
      .run();
    return r.meta.changes ?? 0;
  }

  /**
   * Record that URLs were requested. Callers pass only URLs whose
   * last_requested_at is stale (see Config.requestTouchInterval). URLs that
   * had gone idle get their next check pulled forward to the hot-refresh
   * point (or now, if already expired).
   */
  async touch(urls: string[], now: number, hotRefreshFraction: number): Promise<void> {
    if (urls.length === 0) return;
    await this.db
      .prepare(
        `UPDATE urls SET
           last_requested_at = ?1,
           request_count = request_count + 1,
           next_check_at = CASE
             WHEN idle_level > 0 AND checked_at IS NOT NULL
             THEN MIN(next_check_at, MAX(?1, checked_at + CAST((expires_at - checked_at) * ?2 AS INTEGER)))
             ELSE next_check_at END,
           idle_level = 0
         WHERE url IN (SELECT value FROM json_each(?3))`,
      )
      .bind(now, hotRefreshFraction, JSON.stringify(urls))
      .run();
  }

  // ---- URLs (scheduler side) ----

  /**
   * Due URLs, never-checked first, then by next_check_at. May contain
   * duplicates. `full` says a query hit its limit, i.e. there may be more
   * due rows than we looked at (see dueExcludingHosts).
   */
  async dueCandidates(now: number, limit: number): Promise<{ rows: UrlRow[]; full: boolean }> {
    const [unknown, due] = await this.db.batch([
      this.db
        .prepare(
          `SELECT ${URL_COLS} FROM urls WHERE checked_at IS NULL AND next_check_at <= ?
           ORDER BY next_check_at LIMIT ?`,
        )
        .bind(now, limit),
      this.db
        .prepare(`SELECT ${URL_COLS} FROM urls WHERE next_check_at <= ? ORDER BY next_check_at LIMIT ?`)
        .bind(now, limit),
    ]);
    const u = (unknown as { results: UrlRow[] }).results ?? [];
    const d = (due as { results: UrlRow[] }).results ?? [];
    return { rows: [...u, ...d], full: u.length >= limit || d.length >= limit };
  }

  /**
   * Due URLs of hosts *other than* `hosts`, by next_check_at. Used when one
   * host's backlog fills the whole first window, so other hosts still get
   * their turn. Skipped rows of excluded hosts still count as reads, but only
   * on ticks where the window was full.
   */
  async dueExcludingHosts(now: number, hosts: string[], limit: number): Promise<UrlRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${URL_COLS} FROM urls
         WHERE next_check_at <= ? AND host NOT IN (SELECT value FROM json_each(?))
         ORDER BY next_check_at LIMIT ?`,
      )
      .bind(now, JSON.stringify(hosts), limit)
      .all<UrlRow>();
    return results;
  }

  /** Set next_check_at for URLs (claim before fetching, release on deferral). */
  async setNextCheck(urls: string[], at: number): Promise<void> {
    if (urls.length === 0) return;
    await this.db
      .prepare(`UPDATE urls SET next_check_at = ? WHERE url IN (SELECT value FROM json_each(?))`)
      .bind(at, JSON.stringify(urls))
      .run();
  }

  async applyResults(updates: ResultUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    await this.db
      .prepare(
        `UPDATE urls SET
           status = json_extract(j.value, '$.status'),
           error = json_extract(j.value, '$.error'),
           final_url = json_extract(j.value, '$.final_url'),
           checked_at = json_extract(j.value, '$.checked_at'),
           expires_at = json_extract(j.value, '$.expires_at'),
           next_check_at = json_extract(j.value, '$.next_check_at'),
           consecutive_failures = json_extract(j.value, '$.consecutive_failures'),
           idle_level = json_extract(j.value, '$.idle_level')
         FROM json_each(?) AS j
         WHERE urls.url = json_extract(j.value, '$.url')`,
      )
      .bind(JSON.stringify(updates))
      .run();
  }

  async dropIdle(cutoff: number): Promise<number> {
    const r = await this.db.prepare(`DELETE FROM urls WHERE last_requested_at < ?`).bind(cutoff).run();
    return r.meta.changes ?? 0;
  }

  // ---- Hosts ----

  /** Hosts currently backing off, with the time their backoff ends. */
  async hostsInBackoff(hosts: string[], now: number): Promise<Map<string, number>> {
    if (hosts.length === 0) return new Map();
    const { results } = await this.db
      .prepare(
        `SELECT host, backoff_until FROM hosts
         WHERE backoff_until > ? AND host IN (SELECT value FROM json_each(?))`,
      )
      .bind(now, JSON.stringify(hosts))
      .all<{ host: string; backoff_until: number }>();
    return new Map(results.map((r) => [r.host, r.backoff_until]));
  }

  /**
   * Back off hosts and push their pending URLs past the backoff, spaced
   * `spacing` seconds apart in their current order, so they trickle back at
   * the scheduler's 1-per-host pace instead of all becoming due at once
   * (which would flood the candidate window). Uses urls_host_next.
   */
  async backoffHosts(backoffs: { host: string; until: number }[], spacing: number): Promise<void> {
    if (backoffs.length === 0) return;
    const json = JSON.stringify(backoffs);
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO hosts (host, backoff_until)
           SELECT json_extract(value, '$.host'), json_extract(value, '$.until') FROM json_each(?) WHERE true
           ON CONFLICT(host) DO UPDATE SET backoff_until = MAX(backoff_until, excluded.backoff_until)`,
        )
        .bind(json),
      this.db
        .prepare(
          `UPDATE urls SET next_check_at = s.t
           FROM (SELECT u.url AS url,
                        b.until + ?2 * (ROW_NUMBER() OVER (PARTITION BY u.host ORDER BY u.next_check_at, u.url) - 1) AS t
                 FROM urls u
                 JOIN (SELECT json_extract(value, '$.host') AS host, json_extract(value, '$.until') AS until
                       FROM json_each(?1)) AS b ON u.host = b.host
                 WHERE u.next_check_at < b.until) AS s
           WHERE urls.url = s.url`,
        )
        .bind(json, spacing),
    ]);
  }

  // ---- API keys ----

  async keyByHash(hash: string): Promise<ApiKeyRow | null> {
    return this.db
      .prepare(`SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`)
      .bind(hash)
      .first<ApiKeyRow>();
  }

  async createKey(row: ApiKeyRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (id, key_hash, name, owner, is_admin, new_url_quota_per_day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.key_hash, row.name, row.owner, row.is_admin, row.new_url_quota_per_day, row.created_at)
      .run();
  }

  async listKeys(): Promise<Omit<ApiKeyRow, "key_hash">[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, name, owner, is_admin, new_url_quota_per_day, created_at, revoked_at
         FROM api_keys ORDER BY created_at`,
      )
      .all<Omit<ApiKeyRow, "key_hash">>();
    return results;
  }

  async revokeKey(id: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(now, id)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  /**
   * Atomically reserve up to `n` new URLs against a daily quota; returns how
   * many were granted. The increment happens first (D1 serializes writes),
   * so concurrent requests can't both see the old total; any excess is
   * handed back.
   */
  async reserveNewUrls(keyId: string, day: string, n: number, quota: number): Promise<number> {
    if (n <= 0) return 0;
    const r = await this.db
      .prepare(
        `INSERT INTO api_key_usage (key_id, day, new_urls) VALUES (?1, ?2, ?3)
         ON CONFLICT(key_id, day) DO UPDATE SET new_urls = new_urls + ?3
         RETURNING new_urls`,
      )
      .bind(keyId, day, n)
      .first<{ new_urls: number }>();
    const over = Math.max(0, (r?.new_urls ?? n) - quota);
    const refund = Math.min(n, over);
    if (refund > 0) await this.addNewUrlsUsed(keyId, day, -refund);
    return n - refund;
  }

  async newUrlsUsed(keyId: string, day: string): Promise<number> {
    const r = await this.db
      .prepare(`SELECT new_urls FROM api_key_usage WHERE key_id = ? AND day = ?`)
      .bind(keyId, day)
      .first<{ new_urls: number }>();
    return r?.new_urls ?? 0;
  }

  /** Adjust the day's count by `n` (negative to refund). */
  async addNewUrlsUsed(keyId: string, day: string, n: number): Promise<void> {
    if (n === 0) return;
    await this.db
      .prepare(
        `INSERT INTO api_key_usage (key_id, day, new_urls) VALUES (?1, ?2, ?3)
         ON CONFLICT(key_id, day) DO UPDATE SET new_urls = new_urls + ?3`,
      )
      .bind(keyId, day, n)
      .run();
  }

  // ---- Meta (cached stats, recent activity) ----

  async getMeta<T>(key: string): Promise<{ value: T; updated_at: number } | null> {
    const r = await this.db
      .prepare(`SELECT value, updated_at FROM meta WHERE key = ?`)
      .bind(key)
      .first<{ value: string; updated_at: number }>();
    return r ? { value: JSON.parse(r.value) as T, updated_at: r.updated_at } : null;
  }

  async setMeta(key: string, value: unknown, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, JSON.stringify(value), now)
      .run();
  }

  // ---- Stats ----

  /** Next URLs in schedule order. Index range scan: reads `limit` rows. */
  /**
   * The next `limit` URLs in the scheduler's priority order: never-checked
   * due URLs first, then everything by next_check_at (per-host limits and
   * backoffs aside). Two index scans, each reading at most `limit` rows.
   */
  async upcoming(now: number, limit: number): Promise<UrlRow[]> {
    const [unknown, rest] = await this.db.batch([
      this.db
        .prepare(
          `SELECT ${URL_COLS} FROM urls WHERE checked_at IS NULL AND next_check_at <= ?
           ORDER BY next_check_at LIMIT ?`,
        )
        .bind(now, limit),
      this.db.prepare(`SELECT ${URL_COLS} FROM urls ORDER BY next_check_at LIMIT ?`).bind(limit),
    ]);
    const seen = new Set<string>();
    const out: UrlRow[] = [];
    for (const r of [
      ...((unknown as { results: UrlRow[] }).results ?? []),
      ...((rest as { results: UrlRow[] }).results ?? []),
    ]) {
      if (out.length >= limit) break;
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(r);
    }
    return out;
  }

  /**
   * Queue sizes for the overview, each counting at most `cap` rows via an
   * index: due now (any), never checked (total), never checked and due.
   */
  async queueCounts(
    now: number,
    cap: number,
  ): Promise<{ due: number; unknown: number; unknown_due: number; refresh_due: number }> {
    // Each count is capped independently (a difference of capped counts
    // would be wrong once either hits the cap).
    const r = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM (SELECT 1 FROM urls WHERE next_check_at <= ?1 LIMIT ?2)) AS due,
           (SELECT COUNT(*) FROM (SELECT 1 FROM urls WHERE checked_at IS NULL LIMIT ?2)) AS unknown,
           (SELECT COUNT(*) FROM (SELECT 1 FROM urls WHERE checked_at IS NULL AND next_check_at <= ?1 LIMIT ?2)) AS unknown_due,
           (SELECT COUNT(*) FROM (SELECT 1 FROM urls WHERE checked_at IS NOT NULL AND next_check_at <= ?1 LIMIT ?2)) AS refresh_due`,
      )
      .bind(now, cap)
      .first<{ due: number; unknown: number; unknown_due: number; refresh_due: number }>();
    return {
      due: r?.due ?? 0,
      unknown: r?.unknown ?? 0,
      unknown_due: r?.unknown_due ?? 0,
      refresh_due: r?.refresh_due ?? 0,
    };
  }

  /**
   * One page of the public snapshot, built inside SQLite: a JSON object
   * `{url: [status, error, checked_at, expires_at, consecutive_failures]}` for
   * checked URLs with url > `after`, in primary-key order. Keyset paging keeps
   * each result value well under D1's 2 MB value limit.
   */
  async snapshotPage(
    after: string,
    limit: number,
  ): Promise<{ obj: string; last: string | null; n: number }> {
    // `last` covers never-checked rows too, so paging always advances.
    const r = await this.db
      .prepare(
        `SELECT json_group_object(url,
                  json_array(status, error, checked_at, expires_at, consecutive_failures))
                  FILTER (WHERE checked_at IS NOT NULL) AS obj,
                COUNT(*) FILTER (WHERE checked_at IS NOT NULL) AS n,
                MAX(url) AS last
         FROM (SELECT url, status, error, checked_at, expires_at, consecutive_failures
               FROM urls WHERE url > ? ORDER BY url LIMIT ?)`,
      )
      .bind(after, limit)
      .first<{ obj: string | null; last: string | null; n: number }>();
    return { obj: r?.obj ?? "{}", last: r?.last ?? null, n: r?.n ?? 0 };
  }

  /** Full-table counts. Reads every row: call rarely (maintenance only). */
  async stats(now: number): Promise<Record<string, number>> {
    const r = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS urls,
           SUM(checked_at IS NULL) AS unknown,
           SUM(checked_at IS NOT NULL AND expires_at > ?1) AS fresh,
           SUM(checked_at IS NOT NULL AND expires_at <= ?1) AS stale,
           SUM(next_check_at <= ?1) AS due,
           SUM(consecutive_failures > 0) AS failing,
           SUM(status >= 400 AND status < 500) AS client_errors
         FROM urls`,
      )
      .bind(now)
      .first<Record<string, number | null>>();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(r ?? {})) out[k] = v ?? 0;
    return out;
  }
}
