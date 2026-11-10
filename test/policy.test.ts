import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config.js";
import { applyResult, failureInterval, parseRetryAfter, pickBatch, publicResult } from "../src/policy.js";
import type { UrlRow } from "../src/types.js";

const HOUR = 3600;
const DAY = 24 * HOUR;
const mid = () => 0.5; // no jitter
const NOW = 1_000_000_000;

function row(over: Partial<UrlRow> = {}): UrlRow {
  return {
    url: "https://example.org/",
    host: "example.org",
    status: null,
    error: null,
    final_url: null,
    checked_at: null,
    expires_at: null,
    next_check_at: NOW,
    first_seen_at: NOW,
    last_requested_at: NOW,
    request_count: 1,
    consecutive_failures: 0,
    idle_level: 0,
    ...over,
  };
}

const ok = { status: 200, error: null, finalUrl: "https://example.org/" };

describe("applyResult", () => {
  it("new URL with 200: fresh for 24h, hot refresh at 80%", () => {
    const u = applyResult(row(), ok, NOW, cfg, mid);
    expect(u.expires_at).toBe(NOW + DAY);
    expect(u.next_check_at).toBe(NOW + 0.8 * DAY);
    expect(u.idle_level).toBe(0);
    expect(u.consecutive_failures).toBe(0);
  });

  it("4xx gets the short TTL", () => {
    const u = applyResult(row(), { ...ok, status: 404 }, NOW, cfg, mid);
    expect(u.expires_at).toBe(NOW + 6 * HOUR);
  });

  it("failures back off exponentially, capped at 24h", () => {
    expect(failureInterval(1, cfg)).toBe(15 * 60);
    expect(failureInterval(2, cfg)).toBe(30 * 60);
    expect(failureInterval(3, cfg)).toBe(60 * 60);
    expect(failureInterval(20, cfg)).toBe(DAY);

    let r = row();
    for (const expected of [900, 1800, 3600]) {
      const u = applyResult(r, { status: 503, error: null, finalUrl: null }, NOW, cfg, mid);
      expect(u.next_check_at - NOW).toBe(expected);
      r = { ...r, ...u };
    }
    expect(r.consecutive_failures).toBe(3);
    const u = applyResult(r, ok, NOW, cfg, mid);
    expect(u.consecutive_failures).toBe(0);
  });

  it("network errors are failures", () => {
    const u = applyResult(row(), { status: null, error: "dns", finalUrl: null }, NOW, cfg, mid);
    expect(u.consecutive_failures).toBe(1);
  });

  it("idle URLs back off exponentially up to 7 days", () => {
    // Checked long ago, not requested since.
    let r = row({ checked_at: NOW - 30 * DAY, last_requested_at: NOW - 40 * DAY });
    const intervals: number[] = [];
    for (let i = 0; i < 5; i++) {
      const u = applyResult(r, ok, NOW, cfg, mid);
      intervals.push(u.next_check_at - NOW);
      r = { ...r, ...u, checked_at: NOW - 1 };
    }
    expect(intervals).toEqual([2 * DAY, 4 * DAY, 7 * DAY, 7 * DAY, 7 * DAY]);
    expect(r.idle_level).toBe(5);
  });

  it("requested since last check (within touch slack) counts as hot", () => {
    const r = row({
      checked_at: NOW - DAY,
      last_requested_at: NOW - DAY - cfg.requestTouchInterval + 10,
      idle_level: 3,
    });
    expect(applyResult(r, ok, NOW, cfg, mid).idle_level).toBe(0);
  });

  it("applies jitter within ±10%", () => {
    const lo = applyResult(row(), ok, NOW, cfg, () => 0).next_check_at - NOW;
    const hi = applyResult(row(), ok, NOW, cfg, () => 1).next_check_at - NOW;
    expect(lo).toBe(Math.round(0.8 * DAY * 0.9));
    expect(hi).toBe(Math.round(0.8 * DAY * 1.1));
  });
});

describe("publicResult", () => {
  it("unknown / fresh / stale", () => {
    expect(publicResult(undefined, NOW).state).toBe("unknown");
    expect(publicResult(row(), NOW).state).toBe("unknown");
    const checked = row({ checked_at: NOW - 10, expires_at: NOW + 10, status: 200 });
    expect(publicResult(checked, NOW)).toMatchObject({ state: "fresh", status: 200 });
    expect(publicResult(checked, NOW + 10).state).toBe("stale");
  });
});

describe("pickBatch", () => {
  it("limits per host, skips backoff hosts, dedupes, caps total", () => {
    const rows = [
      row({ url: "https://a.org/1", host: "a.org" }),
      row({ url: "https://a.org/2", host: "a.org" }),
      row({ url: "https://b.org/1", host: "b.org" }),
      row({ url: "https://c.org/1", host: "c.org" }),
      row({ url: "https://b.org/1", host: "b.org" }),
      row({ url: "https://d.org/1", host: "d.org" }),
    ];
    const picked = pickBatch(rows, new Set(["c.org"]), { ...cfg, checksPerTick: 3 });
    expect(picked.map((r) => r.url)).toEqual(["https://a.org/1", "https://b.org/1", "https://d.org/1"]);
  });
});

describe("parseRetryAfter", () => {
  it("handles seconds, dates and garbage", () => {
    expect(parseRetryAfter("120", 0)).toBe(120);
    expect(parseRetryAfter(new Date(60_000).toUTCString(), 0)).toBe(60);
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
