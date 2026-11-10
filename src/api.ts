/** HTTP API. Every endpoint requires a valid key; nothing is anonymous. */
import { bearerToken, generateApiKey, randomToken, sha256Hex, timingSafeEqualHex } from "./auth.js";
import { DEFAULT_KEY_QUOTA, REPO_URL, type Config } from "./config.js";
import { homePage } from "./home.js";
import { publicResult, rejectedResult } from "./policy.js";
import type { ApiKeyRow, NewUrl, Store } from "./store.js";
import type { RecentCheck, TickReport } from "./scheduler.js";
import { looksLikeJwt, matchAllowlist, type Allowlist, type GithubClaims, type OidcGrant } from "./oidc.js";
import { snapshotGeneratedAt, type SnapshotInfo } from "./snapshot.js";
import type { PublicResult } from "./types.js";
import { normalizeUrl } from "./url.js";

export interface ApiDeps {
  store: Store;
  cfg: Config;
  nowMs: () => number;
  /** Bootstrap admin token (Worker secret). Optional. */
  adminToken?: string;
  /** Returns the current public snapshot body, if any (cached by the caller). */
  snapshot?: () => Promise<string | null>;
  /** GitHub Actions OIDC: token verifier + allowlist. Optional. */
  oidc?: { verify: (token: string) => Promise<GithubClaims | null>; allowlist: Allowlist };
}

type Caller =
  | { kind: "key"; key: ApiKeyRow; admin: boolean }
  | { kind: "bootstrap"; admin: true }
  | { kind: "oidc"; grant: OidcGrant; admin: false };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const err = (status: number, error: string) => json({ error }, status);

export async function handleRequest(req: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" && req.method === "GET") {
    // Browsers get the human page; API clients (curl, scripts) get JSON.
    if ((req.headers.get("accept") ?? "").includes("text/html")) {
      return new Response(homePage(url.origin, deps.cfg), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }
    return json({ service: "link-check-proxy", docs: REPO_URL });
  }

  // Public, read-only, never adds URLs: everything in it is already public.
  if (path === "/v1/snapshot.json" && (req.method === "GET" || req.method === "HEAD")) {
    return serveSnapshot(req, deps);
  }

  const caller = await authenticate(req, deps);
  if (!caller) return err(401, "missing or invalid API key or OIDC token");
  if ("denied" in caller) return err(403, caller.denied);

  try {
    if (path === "/v1/check" && req.method === "POST") return await check(req, caller, deps);
    if (path === "/v1/url" && req.method === "GET") return await single(url, deps);

    if (path.startsWith("/v1/admin/")) {
      if (!caller.admin) return err(403, "admin only");
      if (path === "/v1/admin/keys" && req.method === "POST") return await createKey(req, deps);
      if (path === "/v1/admin/keys" && req.method === "GET") {
        return json({ keys: await deps.store.listKeys() });
      }
      const m = /^\/v1\/admin\/keys\/([\w-]+)$/.exec(path);
      if (m && req.method === "DELETE") {
        const ok = await deps.store.revokeKey(m[1]!, Math.floor(deps.nowMs() / 1000));
        return ok ? json({ revoked: m[1] }) : err(404, "no such active key");
      }
      if (path === "/v1/admin/overview" && req.method === "GET") return await overview(url, deps);
      if (path === "/v1/admin/stats" && req.method === "GET") {
        return json(await deps.store.stats(Math.floor(deps.nowMs() / 1000)));
      }
    }
    return err(404, "not found");
  } catch (e) {
    console.error("request failed", e);
    return err(500, "internal error");
  }
}

async function authenticate(req: Request, deps: ApiDeps): Promise<Caller | { denied: string } | null> {
  const token = bearerToken(req);
  if (!token) return null;
  if (looksLikeJwt(token)) {
    if (!deps.oidc) return null;
    let claims: GithubClaims | null = null;
    try {
      claims = await deps.oidc.verify(token);
    } catch (e) {
      console.error("OIDC verification error", e);
      return null;
    }
    if (!claims) return null;
    const grant = matchAllowlist(claims, deps.oidc.allowlist);
    if (!grant) {
      return {
        denied: `${claims.repository} is not in the OIDC allowlist (config/github-oidc.json); open a PR to add it`,
      };
    }
    return { kind: "oidc", grant, admin: false };
  }
  const hash = await sha256Hex(token);
  if (deps.adminToken && timingSafeEqualHex(hash, await sha256Hex(deps.adminToken))) {
    return { kind: "bootstrap", admin: true };
  }
  const key = await deps.store.keyByHash(hash);
  return key ? { kind: "key", key, admin: key.is_admin === 1 } : null;
}

async function check(req: Request, caller: Caller, deps: ApiDeps): Promise<Response> {
  const { store, cfg } = deps;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "body must be JSON");
  }
  const input = (body as { urls?: unknown })?.urls;
  if (!Array.isArray(input)) return err(400, "expected {\"urls\": [...]}");
  if (input.length > cfg.maxUrlsPerRequest) {
    return err(413, `at most ${cfg.maxUrlsPerRequest} URLs per request`);
  }

  const nowMs = deps.nowMs();
  const now = Math.floor(nowMs / 1000);
  const results: Record<string, PublicResult> = {};

  // original string -> normalized
  const normalized = new Map<string, { url: string; host: string }>();
  for (const raw of input) {
    const n = normalizeUrl(raw, cfg.maxUrlLength);
    const key = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (n.ok) normalized.set(key, { url: n.url, host: n.host });
    else results[key] = rejectedResult(n.reason);
  }

  const unique = new Map<string, string>(); // url -> host
  for (const { url, host } of normalized.values()) unique.set(url, host);
  const known = await store.lookup([...unique.keys()]);

  // Read-only callers (OIDC runs from pull_request etc.) never add URLs.
  const readOnly = caller.kind === "oidc" && caller.grant.readOnly;
  const quota =
    caller.kind === "key"
      ? { id: caller.key.id, limit: caller.key.new_url_quota_per_day }
      : caller.kind === "oidc"
        ? { id: caller.grant.usageId, limit: caller.grant.quota }
        : null; // bootstrap admin: unlimited

  // New URLs, subject to the caller's daily quota.
  let fresh = [...unique.keys()].filter((u) => !known.has(u));
  const overQuota = new Set<string>();
  const notQueued = new Set<string>();
  if (readOnly) {
    for (const u of fresh) notQueued.add(u);
    fresh = [];
  } else if (fresh.length > 0 && quota) {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const used = await store.newUrlsUsed(quota.id, day);
    const allowed = Math.max(0, quota.limit - used);
    for (const u of fresh.slice(allowed)) overQuota.add(u);
    fresh = fresh.slice(0, allowed);
    await store.addNewUrlsUsed(quota.id, day, fresh.length);
  }
  await store.insertNew(spreadNewUrls(fresh, unique, now, cfg.newUrlHostSpacing), now);

  const toTouch = [...known.values()]
    .filter((r) => r.last_requested_at < now - cfg.requestTouchInterval)
    .map((r) => r.url);
  await store.touch(toTouch, now, cfg.hotRefreshFraction);

  for (const [raw, { url }] of normalized) {
    if (overQuota.has(url)) results[raw] = rejectedResult("new_url_quota_exceeded");
    else if (notQueued.has(url)) results[raw] = { ...publicResult(undefined, now), reason: "read_only_not_queued" };
    else results[raw] = publicResult(known.get(url), now);
  }
  return json({ mode: readOnly ? "read_only" : "full", results });
}

/**
 * New URLs of the same host are spaced `spacing` seconds apart so a large
 * batch for one host trickles out instead of clogging the queue head.
 */
export function spreadNewUrls(
  urls: string[],
  hostOf: Map<string, string>,
  now: number,
  spacing: number,
): NewUrl[] {
  const perHost = new Map<string, number>();
  return urls.map((url) => {
    const host = hostOf.get(url)!;
    const k = perHost.get(host) ?? 0;
    perHost.set(host, k + 1);
    return { url, host, next_check_at: now + k * spacing };
  });
}

async function single(url: URL, deps: ApiDeps): Promise<Response> {
  const u = url.searchParams.get("u");
  const n = normalizeUrl(u, deps.cfg.maxUrlLength);
  if (!n.ok) return json({ url: u, result: rejectedResult(n.reason) });
  const row = (await deps.store.lookup([n.url])).get(n.url);
  const now = Math.floor(deps.nowMs() / 1000);
  return json({
    url: n.url,
    result: publicResult(row, now),
    schedule: row
      ? {
          next_check_at: new Date(row.next_check_at * 1000).toISOString(),
          idle_level: row.idle_level,
          request_count: row.request_count,
          last_requested_at: new Date(row.last_requested_at * 1000).toISOString(),
        }
      : null,
  });
}

async function serveSnapshot(req: Request, deps: ApiDeps): Promise<Response> {
  const body = deps.snapshot ? await deps.snapshot() : null;
  if (body === null) return err(503, "snapshot not generated yet; it is rebuilt hourly");
  const etag = `"snap-${snapshotGeneratedAt(body) ?? body.length}"`;
  const headers = {
    "content-type": "application/json",
    "cache-control": "public, max-age=300",
    etag,
    "access-control-allow-origin": "*",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : body, { headers });
}

const DUE_COUNT_CAP = 1000;

/**
 * Cheap dashboard data: cached stats (refreshed hourly by the cron tick),
 * the recent-checks log, and the head of the schedule. Safe to poll.
 */
async function overview(url: URL, deps: ApiDeps): Promise<Response> {
  const { store } = deps;
  const now = Math.floor(deps.nowMs() / 1000);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
  const [stats, lastTick, recent, upcoming, due, snapshot] = await Promise.all([
    store.getMeta<Record<string, number>>("stats"),
    store.getMeta<TickReport>("last_tick"),
    store.getMeta<RecentCheck[]>("recent"),
    store.upcoming(limit),
    store.dueCount(now, DUE_COUNT_CAP),
    store.getMeta<SnapshotInfo>("snapshot"),
  ]);
  return json({
    now,
    stats: stats ? { ...stats.value, computed_at: stats.updated_at } : null,
    last_tick: lastTick ? { ...lastTick.value, at: lastTick.updated_at } : null,
    snapshot: snapshot?.value ?? null,
    due_now: due,
    due_capped: due >= DUE_COUNT_CAP,
    upcoming: upcoming.map((r) => ({
      url: r.url,
      state: publicResult(r, now).state,
      status: r.status,
      error: r.error,
      checked_at: r.checked_at,
      next_check_at: r.next_check_at,
      idle_level: r.idle_level,
    })),
    recent: (recent?.value ?? []).slice(0, limit),
  });
}

async function createKey(req: Request, deps: ApiDeps): Promise<Response> {
  let body: { name?: unknown; owner?: unknown; quota?: unknown; admin?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return err(400, "body must be JSON");
  }
  if (typeof body.name !== "string" || body.name.trim() === "") return err(400, "name is required");
  const quota = body.quota === undefined ? DEFAULT_KEY_QUOTA : Number(body.quota);
  if (!Number.isInteger(quota) || quota < 0) return err(400, "quota must be a non-negative integer");

  const key = generateApiKey();
  const row: ApiKeyRow = {
    id: `key_${randomToken(12)}`,
    key_hash: await sha256Hex(key),
    name: body.name.trim(),
    owner: typeof body.owner === "string" ? body.owner : null,
    is_admin: body.admin === true ? 1 : 0,
    new_url_quota_per_day: quota,
    created_at: Math.floor(deps.nowMs() / 1000),
    revoked_at: null,
  };
  await deps.store.createKey(row);
  return json({ id: row.id, key, name: row.name, note: "store this key now; it is not shown again" }, 201);
}
