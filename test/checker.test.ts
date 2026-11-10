import { describe, expect, it } from "vitest";
import { Budget, checkUrl, classifyError, type FetchFn } from "../src/checker.js";
import { DEFAULT_CONFIG as cfg } from "../src/config.js";

type Route = (method: string) => Response | Error;

function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    const out = r(init.method ?? "GET");
    if (out instanceof Error) throw out;
    return out;
  };
  return { fn, calls };
}

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

describe("checkUrl", () => {
  it("uses HEAD when it works", async () => {
    const f = fakeFetch({ "https://a.org/": () => res(200) });
    const o = await checkUrl("https://a.org/", f.fn, new Budget(10), cfg);
    expect(o).toEqual({ kind: "result", status: 200, error: null, finalUrl: "https://a.org/" });
    expect(f.calls).toEqual(["HEAD https://a.org/"]);
  });

  it("falls back to GET on 405", async () => {
    const f = fakeFetch({ "https://a.org/": (m) => res(m === "HEAD" ? 405 : 200) });
    const o = await checkUrl("https://a.org/", f.fn, new Budget(10), cfg);
    expect(o).toMatchObject({ status: 200 });
    expect(f.calls).toEqual(["HEAD https://a.org/", "GET https://a.org/"]);
  });

  it("follows redirects and records the final URL", async () => {
    const f = fakeFetch({
      "http://a.org/": () => res(301, { location: "https://a.org/" }),
      "https://a.org/": () => res(302, { location: "/docs/" }),
      "https://a.org/docs/": () => res(200),
    });
    const o = await checkUrl("http://a.org/", f.fn, new Budget(10), cfg);
    expect(o).toEqual({ kind: "result", status: 200, error: null, finalUrl: "https://a.org/docs/" });
  });

  it("refuses redirects to private addresses", async () => {
    const f = fakeFetch({
      "https://a.org/": () => res(302, { location: "http://169.254.169.254/" }),
    });
    const o = await checkUrl("https://a.org/", f.fn, new Budget(10), cfg);
    expect(o).toMatchObject({ kind: "result", error: "blocked" });
    expect(f.calls).toEqual(["HEAD https://a.org/"]);
  });

  it("detects redirect loops", async () => {
    const f = fakeFetch({
      "https://a.org/x": () => res(302, { location: "/y" }),
      "https://a.org/y": () => res(302, { location: "/x" }),
    });
    const o = await checkUrl("https://a.org/x", f.fn, new Budget(100), cfg);
    expect(o).toMatchObject({ kind: "result", error: "too_many_redirects" });
  });

  it("reports 429 as rate_limited with Retry-After", async () => {
    const f = fakeFetch({ "https://a.org/": () => res(429, { "retry-after": "300" }) });
    const o = await checkUrl("https://a.org/", f.fn, new Budget(10), cfg);
    expect(o).toEqual({ kind: "rate_limited", retryAfter: 300, host: "a.org" });
  });

  it("flags Cloudflare challenges", async () => {
    const f = fakeFetch({ "https://a.org/": () => res(403, { "cf-mitigated": "challenge" }) });
    const o = await checkUrl("https://a.org/", f.fn, new Budget(10), cfg);
    expect(o).toMatchObject({ status: 403, error: "challenged" });
  });

  it("does not retry DNS/timeout/TLS errors with GET", async () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const f = fakeFetch({ "https://nope.example/": () => e });
    const o = await checkUrl("https://nope.example/", f.fn, new Budget(10), cfg);
    expect(o).toMatchObject({ kind: "result", status: null, error: "dns" });
    expect(f.calls).toHaveLength(1);
  });

  it("retries connection errors with GET", async () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const f = fakeFetch({ "https://a.org/": (m) => (m === "HEAD" ? e : res(200)) });
    const o = await checkUrl("https://a.org/", f.fn, new Budget(10), cfg);
    expect(o).toMatchObject({ kind: "result", status: 200 });
    expect(f.calls).toHaveLength(2);
  });

  it("reports the host that said 429 after a redirect", async () => {
    const f = fakeFetch({
      "https://a.org/x": () => res(301, { location: "https://b.org/y" }),
      "https://b.org/y": () => res(429),
    });
    const o = await checkUrl("https://a.org/x", f.fn, new Budget(10), cfg);
    expect(o).toEqual({ kind: "rate_limited", retryAfter: null, host: "b.org" });
  });

  it("defers instead of starting fetches past the tick deadline", async () => {
    let t = 0;
    const f = fakeFetch({ "https://a.org/": () => res(200) });
    const budget = new Budget(10, 1000, () => t);
    t = 1000;
    expect(await checkUrl("https://a.org/", f.fn, budget, cfg)).toEqual({ kind: "deferred" });
    expect(f.calls).toHaveLength(0);
  });

  it("a timeout cut short by the deadline is deferred, not recorded", async () => {
    let t = 0;
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const f = fakeFetch({ "https://a.org/": () => timeout });
    // Only 1 s left of the tick, less than the 5 s fetch timeout.
    expect(await checkUrl("https://a.org/", f.fn, new Budget(10, 1000, () => t), cfg)).toEqual({ kind: "deferred" });
    // With plenty of time left, a timeout is a real result.
    expect(await checkUrl("https://a.org/", f.fn, new Budget(10, 60_000, () => t), cfg)).toMatchObject({ error: "timeout" });
  });

  it("defers when the fetch budget runs out", async () => {
    const f = fakeFetch({ "https://a.org/": (m) => res(m === "HEAD" ? 405 : 200) });
    const o = await checkUrl("https://a.org/", f.fn, new Budget(1), cfg);
    expect(o).toEqual({ kind: "deferred" });
  });
});

describe("classifyError", () => {
  it.each([
    [Object.assign(new Error("x"), { name: "TimeoutError" }), "timeout"],
    [new Error("certificate has expired"), "tls"],
    [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), "connect"],
    [new Error("weird"), "other"],
  ])("%s -> %s", (e, kind) => {
    expect(classifyError(e)).toBe(kind);
  });
});
