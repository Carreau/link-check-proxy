/** API + scheduler against a real SQLite DB with the real migration. */
import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/api.js";
import type { FetchFn } from "../src/checker.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { runTick } from "../src/scheduler.js";
import { Store } from "../src/store.js";
import { createTestDb } from "./sqlite-d1.js";

const ADMIN = "admin-secret";
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const DAY_MS = 86_400_000;

let db: ReturnType<typeof createTestDb>;
let store: Store;
let clock: number;
let cfg: Config;

beforeEach(() => {
  db = createTestDb();
  store = new Store(db);
  clock = T0;
  cfg = { ...DEFAULT_CONFIG };
});

const call = (method: string, path: string, token?: string, body?: unknown) =>
  handleRequest(
    new Request(`https://proxy.test${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { store, cfg, nowMs: () => clock, adminToken: ADMIN },
  );

async function newKey(quota?: number): Promise<string> {
  const r = await call("POST", "/v1/admin/keys", ADMIN, { name: "test", quota });
  expect(r.status).toBe(201);
  return ((await r.json()) as { key: string }).key;
}

async function check(key: string, urls: unknown[]) {
  const r = await call("POST", "/v1/check", key, { urls });
  expect(r.status).toBe(200);
  return ((await r.json()) as { results: Record<string, any> }).results;
}

const okFetch =
  (statuses: Record<string, number> = {}): FetchFn =>
  async (url) =>
    new Response(null, { status: statuses[url] ?? 200 });

const tick = (fetchFn: FetchFn, extra: Partial<Parameters<typeof runTick>[0]> = {}) =>
  runTick({ store, fetchFn, cfg, nowMs: clock, rand: () => 0.5, ...extra });

describe("auth", () => {
  it("refuses requests without a valid key", async () => {
    expect((await call("POST", "/v1/check", undefined, { urls: [] })).status).toBe(401);
    expect((await call("POST", "/v1/check", "lcp_bogus", { urls: [] })).status).toBe(401);
    expect((await call("GET", "/v1/url?u=https://a.org/")).status).toBe(401);
    // Nothing was inserted.
    expect(await store.stats(0)).toMatchObject({ urls: 0 });
  });

  it("non-admin keys cannot use admin endpoints", async () => {
    const key = await newKey();
    expect((await call("GET", "/v1/admin/stats", key)).status).toBe(403);
    expect((await call("POST", "/v1/admin/keys", key, { name: "x" })).status).toBe(403);
  });

  it("revoked keys stop working", async () => {
    const r = await call("POST", "/v1/admin/keys", ADMIN, { name: "t" });
    const { id, key } = (await r.json()) as { id: string; key: string };
    expect((await call("POST", "/v1/check", key, { urls: [] })).status).toBe(200);
    expect((await call("DELETE", `/v1/admin/keys/${id}`, ADMIN)).status).toBe(200);
    expect((await call("POST", "/v1/check", key, { urls: [] })).status).toBe(401);
  });
});

describe("check flow", () => {
  it("unknown → checked in background → fresh → stale", async () => {
    const key = await newKey();
    const urls = ["https://a.org/", "https://b.org/missing#frag", "ftp://x.org/"];

    const first = await check(key, urls);
    expect(first["https://a.org/"].state).toBe("unknown");
    expect(first["https://b.org/missing#frag"].state).toBe("unknown");
    expect(first["ftp://x.org/"]).toMatchObject({ state: "rejected", reason: "unsupported_scheme" });

    const report = await tick(okFetch({ "https://b.org/missing": 404 }));
    expect(report).toMatchObject({ picked: 2, results: 2 });

    const second = await check(key, urls);
    expect(second["https://a.org/"]).toMatchObject({ state: "fresh", status: 200 });
    expect(second["https://b.org/missing#frag"]).toMatchObject({ state: "fresh", status: 404 });

    clock += 7 * 3600 * 1000; // past the 6h TTL for 4xx
    const third = await check(key, urls);
    expect(third["https://a.org/"].state).toBe("fresh");
    expect(third["https://b.org/missing#frag"].state).toBe("stale");
  });

  it("spreads many new URLs of one host across ticks", async () => {
    const key = await newKey();
    const urls = Array.from({ length: 5 }, (_, i) => `https://gh.org/${i}`);
    await check(key, urls);
    const rows = [...(await store.lookup(urls)).values()].map((r) => r.next_check_at).sort();
    const t = Math.floor(T0 / 1000);
    expect(rows).toEqual([t, t + 60, t + 120, t + 180, t + 240]);

    expect((await tick(okFetch())).picked).toBe(1);
    clock += 60_000;
    expect((await tick(okFetch())).picked).toBe(1);
  });

  it("enforces the daily new-URL quota", async () => {
    const key = await newKey(2);
    const res = await check(key, ["https://a.org/1", "https://a.org/2", "https://a.org/3"]);
    expect(res["https://a.org/3"]).toMatchObject({ state: "rejected", reason: "new_url_quota_exceeded" });
    // Already-known URLs don't count against the quota.
    const again = await check(key, ["https://a.org/1"]);
    expect(again["https://a.org/1"].state).toBe("unknown");
    // Next day the quota resets.
    clock += DAY_MS;
    const next = await check(key, ["https://a.org/3"]);
    expect(next["https://a.org/3"].state).toBe("unknown");
  });

  it("rejects oversized requests and bad bodies", async () => {
    const key = await newKey();
    cfg.maxUrlsPerRequest = 2;
    expect((await call("POST", "/v1/check", key, { urls: ["a", "b", "c"] })).status).toBe(413);
    expect((await call("POST", "/v1/check", key, { nope: 1 })).status).toBe(400);
  });
});

describe("scheduler", () => {
  it("429 backs off the whole host", async () => {
    const key = await newKey();
    cfg.newUrlHostSpacing = 0;
    await check(key, ["https://rl.org/1", "https://rl.org/2", "https://ok.org/"]);
    const fetchFn: FetchFn = async (url) =>
      new Response(null, url.startsWith("https://rl.org") ? { status: 429, headers: { "retry-after": "600" } } : { status: 200 });

    const r1 = await tick(fetchFn);
    expect(r1).toMatchObject({ picked: 2, rateLimited: 1, results: 1 });

    const rows = await store.lookup(["https://rl.org/1", "https://rl.org/2"]);
    for (const row of rows.values()) {
      expect(row.next_check_at).toBeGreaterThanOrEqual(Math.floor(clock / 1000) + 600);
      expect(row.checked_at).toBeNull();
    }
    // Nothing from rl.org is picked during the backoff.
    clock += 300_000;
    expect((await tick(fetchFn)).picked).toBe(0);
  });

  it("idle URLs back off and are eventually dropped; requests revive them", async () => {
    const key = await newKey();
    await check(key, ["https://a.org/"]);
    await tick(okFetch());

    // Nobody asks again: successive checks get further apart.
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      const row = (await store.lookup(["https://a.org/"])).get("https://a.org/")!;
      gaps.push(row.next_check_at - Math.floor(clock / 1000));
      clock = row.next_check_at * 1000;
      await tick(okFetch());
    }
    // The first re-check still counts as hot (last_requested_at has
    // requestTouchInterval of slack); after that the interval doubles.
    expect(gaps[0]).toBe(gaps[1]);
    expect(gaps[1]).toBeLessThan(gaps[2]!);
    expect(gaps[2]).toBeLessThan(gaps[3]!);

    // A request resets idleness and pulls the next check forward.
    const before = (await store.lookup(["https://a.org/"])).get("https://a.org/")!;
    expect(before.idle_level).toBeGreaterThan(0);
    await check(key, ["https://a.org/"]);
    const after = (await store.lookup(["https://a.org/"])).get("https://a.org/")!;
    expect(after.idle_level).toBe(0);
    expect(after.next_check_at).toBeLessThan(before.next_check_at);

    // 31 days without requests: dropped.
    clock += 31 * DAY_MS;
    const r = await tick(okFetch(), { dropIdle: true });
    expect(r.dropped).toBe(1);
    expect((await store.lookup(["https://a.org/"])).size).toBe(0);
  });

  it("stays within the fetch budget", async () => {
    const key = await newKey();
    cfg.fetchBudgetPerTick = 3;
    await check(key, ["https://a.org/", "https://b.org/", "https://c.org/", "https://d.org/"]);
    let fetches = 0;
    const r = await tick(async () => {
      fetches++;
      return new Response(null, { status: 200 });
    });
    expect(fetches).toBe(3);
    expect(r).toMatchObject({ picked: 4, results: 3, deferred: 1 });
  });
});

describe("admin overview", () => {
  it("reports cached stats, last tick, upcoming and recent checks", async () => {
    const key = await newKey();
    await check(key, ["https://a.org/", "https://b.org/x", "https://c.org/"]);

    const before = await call("GET", "/v1/admin/overview?limit=10", ADMIN);
    const b = (await before.json()) as any;
    expect(b.stats).toBeNull();
    expect(b.last_tick).toBeNull();
    expect(b.due_now).toBe(3);
    expect(b.upcoming.map((u: any) => u.state)).toEqual(["unknown", "unknown", "unknown"]);

    await tick(okFetch({ "https://b.org/x": 404 }));
    clock += 60_000;

    const after = (await (await call("GET", "/v1/admin/overview", ADMIN)).json()) as any;
    expect(after.stats).toMatchObject({ urls: 3, fresh: 3, unknown: 0 });
    expect(after.last_tick).toMatchObject({ picked: 3, results: 3 });
    expect(after.due_now).toBe(0);
    expect(after.recent).toHaveLength(3);
    expect(after.recent.find((r: any) => r.url === "https://b.org/x")).toMatchObject({ status: 404, kind: "result" });
    // 4xx has the shortest TTL, so it is next in line.
    expect(after.upcoming[0].url).toBe("https://b.org/x");

    const key2 = await newKey();
    expect((await call("GET", "/v1/admin/overview", key2)).status).toBe(403);
  });
});
