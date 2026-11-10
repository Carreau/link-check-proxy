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
    expect(o).toEqual({ kind: "rate_limited", retryAfter: 300 });
  });

  it("flags Cloudflare challenges", async () => {
    const f = fakeFetch({ "https://a.org/": () => res(403, { "cf-mitigated": "challenge" }) });
    const o = await checkUrl("https://a.org/", f.fn, new Budget(10), cfg);
    expect(o).toMatchObject({ status: 403, error: "challenged" });
  });

  it("classifies network errors, retrying with GET", async () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const f = fakeFetch({ "https://nope.example/": () => e });
    const o = await checkUrl("https://nope.example/", f.fn, new Budget(10), cfg);
    expect(o).toMatchObject({ kind: "result", status: null, error: "dns" });
    expect(f.calls).toHaveLength(2);
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
