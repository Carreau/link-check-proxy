import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../src/url.js";

const n = (s: unknown) => normalizeUrl(s, 2048);

describe("normalizeUrl", () => {
  it("strips fragments and lowercases host", () => {
    expect(n("https://Example.ORG/a/B?x=1#frag")).toEqual({
      ok: true,
      url: "https://example.org/a/B?x=1",
      host: "example.org",
    });
  });

  it("drops default ports", () => {
    expect(n("https://example.org:443/")).toMatchObject({ url: "https://example.org/" });
  });

  it.each([
    ["ftp://example.org/", "unsupported_scheme"],
    ["mailto:a@b.org", "unsupported_scheme"],
    ["not a url", "invalid_url"],
    ["https://user:pw@example.org/", "credentials"],
    ["http://localhost:8000/", "private_address"],
    ["http://foo.localhost/", "private_address"],
    ["http://127.0.0.1/", "private_address"],
    ["http://10.1.2.3/", "private_address"],
    ["http://172.20.0.1/", "private_address"],
    ["http://192.168.1.1/", "private_address"],
    ["http://169.254.169.254/latest/meta-data", "private_address"],
    ["http://[::1]/", "private_address"],
    ["http://[fd00::1]/", "private_address"],
    ["http://[::ffff:127.0.0.1]/", "private_address"],
    ["http://intranet/", "private_address"],
  ])("rejects %s", (url, reason) => {
    expect(n(url)).toEqual({ ok: false, reason });
  });

  it("accepts public IPs", () => {
    expect(n("http://8.8.8.8/")).toMatchObject({ ok: true });
    expect(n("http://172.32.0.1/")).toMatchObject({ ok: true });
  });

  it("rejects non-strings and long URLs", () => {
    expect(n(42)).toEqual({ ok: false, reason: "not_a_string" });
    expect(normalizeUrl("https://example.org/" + "a".repeat(100), 50)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});
