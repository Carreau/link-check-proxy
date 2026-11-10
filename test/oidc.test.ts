import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import allowlistFile from "../config/github-oidc.json";
import { handleRequest } from "../src/api.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  JwksCache,
  OIDC_ISSUER,
  matchAllowlist,
  validateAllowlist,
  verifyGithubToken,
  type Allowlist,
  type GithubClaims,
} from "../src/oidc.js";
import { Store } from "../src/store.js";
import { createTestDb } from "./sqlite-d1.js";

const NOW = 1_800_000_000;
const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url");

let keys: CryptoKeyPair;
let otherKeys: CryptoKeyPair;
let jwksBody: string;

beforeAll(async () => {
  const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKeys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  jwksBody = JSON.stringify({ keys: [{ ...jwk, kid: "k1", use: "sig", alg: "RS256" }] });
});

function claims(over: Partial<GithubClaims> = {}): GithubClaims {
  return {
    iss: OIDC_ISSUER,
    aud: "link-check-proxy",
    exp: NOW + 300,
    iat: NOW - 10,
    nbf: NOW - 10,
    repository: "jupyter/notebook",
    repository_id: "1",
    repository_owner: "jupyter",
    repository_owner_id: "7388996",
    event_name: "push",
    ...over,
  };
}

async function sign(c: object, opts: { kid?: string; key?: CryptoKey; alg?: string } = {}) {
  const head = b64url(JSON.stringify({ alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? "k1" }));
  const body = b64url(JSON.stringify(c));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

function cache(opts: { fail?: () => boolean; clock?: () => number } = {}) {
  let fetches = 0;
  const c = new JwksCache(async () => {
    fetches++;
    if (opts.fail?.()) throw new Error("github down");
    return new Response(jwksBody);
  }, opts.clock ?? (() => NOW * 1000));
  return { c, fetches: () => fetches };
}

describe("verifyGithubToken", () => {
  it("accepts a valid token", async () => {
    const { c } = cache();
    expect(await verifyGithubToken(await sign(claims()), c.lookup, NOW)).toMatchObject({ repository: "jupyter/notebook" });
  });

  it.each([
    ["wrong issuer", { iss: "https://evil.example" }],
    ["wrong audience", { aud: "something-else" }],
    ["expired", { exp: NOW - 120 }],
    ["not yet valid", { nbf: NOW + 120 }],
    ["missing repository_id", { repository_id: "" }],
  ])("rejects %s", async (_label, over) => {
    const { c } = cache();
    expect(await verifyGithubToken(await sign(claims(over as Partial<GithubClaims>)), c.lookup, NOW)).toBeNull();
  });

  it("accepts an audience array containing ours", async () => {
    const { c } = cache();
    expect(await verifyGithubToken(await sign(claims({ aud: ["x", "link-check-proxy"] })), c.lookup, NOW)).not.toBeNull();
  });

  it("rejects bad signatures, unknown kids, other algorithms, tampering, garbage", async () => {
    const { c } = cache();
    expect(await verifyGithubToken(await sign(claims(), { key: otherKeys.privateKey }), c.lookup, NOW)).toBeNull();
    expect(await verifyGithubToken(await sign(claims(), { kid: "nope" }), c.lookup, NOW)).toBeNull();
    expect(await verifyGithubToken(await sign(claims(), { alg: "HS256" }), c.lookup, NOW)).toBeNull();
    const [h, , s] = (await sign(claims())).split(".");
    const forged = `${h}.${b64url(JSON.stringify(claims({ repository_owner_id: "42" })))}.${s}`;
    expect(await verifyGithubToken(forged, c.lookup, NOW)).toBeNull();
    expect(await verifyGithubToken("eyJ.not.ajwt", c.lookup, NOW)).toBeNull();
  });

  it("caches keys and limits refetches on unknown kids", async () => {
    let t = NOW * 1000;
    const { c, fetches } = cache({ clock: () => t });
    await verifyGithubToken(await sign(claims()), c.lookup, NOW);
    await verifyGithubToken(await sign(claims()), c.lookup, NOW);
    expect(fetches()).toBe(1);
    // Unknown kid right after a fetch: no refetch (keys are fresh).
    await verifyGithubToken(await sign(claims(), { kid: "x" }), c.lookup, NOW);
    expect(fetches()).toBe(1);
    t += 61_000;
    await verifyGithubToken(await sign(claims(), { kid: "x" }), c.lookup, NOW);
    await verifyGithubToken(await sign(claims(), { kid: "y" }), c.lookup, NOW);
    expect(fetches()).toBe(2); // one miss-refetch per minute
  });

  it("keeps using cached keys when a refresh fails", async () => {
    let t = NOW * 1000;
    let down = false;
    const { c } = cache({ clock: () => t, fail: () => down });
    expect(await verifyGithubToken(await sign(claims()), c.lookup, NOW)).not.toBeNull();
    down = true;
    t += 2 * 3600_000; // cache is stale, GitHub unreachable
    expect(await verifyGithubToken(await sign(claims()), c.lookup, NOW)).not.toBeNull();
  });

  it("with no cached keys, a failed fetch rejects (401 upstream)", async () => {
    const { c } = cache({ fail: () => true });
    await expect(verifyGithubToken(await sign(claims()), c.lookup, NOW)).rejects.toThrow(/github down/);
  });
});

describe("allowlist", () => {
  it("the committed config/github-oidc.json is valid", () => {
    expect(validateAllowlist(allowlistFile)).toEqual([]);
  });

  it("reports problems", () => {
    expect(validateAllowlist({})).toHaveLength(1);
    const errs = validateAllowlist({
      entries: [
        { name: "a", owner: "x" }, // no id
        { name: "a", repository: "x/y", repository_id: 1 }, // dup name
        { name: "b", owner: "x", owner_id: 1, repository: "x/y", repository_id: 2 }, // both
        { name: "c", repository: "nope", repository_id: 3 },
        { name: "d", repository: "x/z", repository_id: 1 }, // dup id
      ],
    });
    expect(errs.join("\n")).toMatch(/owner_id must be/);
    expect(errs.join("\n")).toMatch(/duplicate name/);
    expect(errs.join("\n")).toMatch(/either owner/);
    expect(errs.join("\n")).toMatch(/"owner\/name"/);
    expect(errs.join("\n")).toMatch(/duplicate repository_id/);
  });

  const list: Allowlist = {
    entries: [
      { name: "Jupyter", owner: "jupyter", owner_id: 7388996, new_url_quota_per_day: 100 },
      { name: "special", repository: "jupyter/special", repository_id: 99, new_url_quota_per_day: 7 },
    ],
  };

  it("matches by id, not by name; repo entry wins over org", () => {
    expect(matchAllowlist(claims(), list)?.entry.name).toBe("Jupyter");
    expect(matchAllowlist(claims({ repository_id: "99" }), list)).toMatchObject({ usageId: "oidc:special", quota: 7 });
    // Same name, different id (e.g. a re-registered org): no match.
    expect(matchAllowlist(claims({ repository_owner_id: "123" }), list)).toBeNull();
  });

  it("entries with a pending (null) id are flagged and never match", () => {
    const pending: Allowlist = { entries: [{ name: "NumPy", owner: "numpy", owner_id: null }] };
    expect(validateAllowlist(pending).join("\n")).toMatch(/owner_id must be .*check_allowlist/);
    expect(matchAllowlist(claims({ repository_owner_id: "0" }), pending)).toBeNull();
    expect(matchAllowlist(claims(), pending)).toBeNull();
  });

  it("defaults to 500 new URLs per day", () => {
    expect(matchAllowlist(claims(), { entries: [{ name: "J", owner: "jupyter", owner_id: 7388996 }] })?.quota).toBe(500);
  });

  it("only push/schedule/workflow_dispatch/merge_group get full access", () => {
    for (const ev of ["push", "schedule", "workflow_dispatch", "merge_group"]) {
      expect(matchAllowlist(claims({ event_name: ev }), list)?.readOnly).toBe(false);
    }
    for (const ev of ["pull_request", "pull_request_target", "issue_comment", "release"]) {
      expect(matchAllowlist(claims({ event_name: ev }), list)?.readOnly).toBe(true);
    }
  });
});

describe("API with OIDC", () => {
  let store: Store;
  const list: Allowlist = { entries: [{ name: "Jupyter", owner: "jupyter", owner_id: 7388996, new_url_quota_per_day: 2 }] };

  beforeEach(() => {
    store = new Store(createTestDb());
  });

  const call = async (token: string, urls: string[]) => {
    const { c } = cache();
    const res = await handleRequest(
      new Request("https://proxy.test/v1/check", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ urls }),
      }),
      {
        store,
        cfg: DEFAULT_CONFIG,
        nowMs: () => NOW * 1000,
        oidc: { verify: (t) => verifyGithubToken(t, c.lookup, NOW), allowlist: list },
      },
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  it("push runs add URLs, within the entry's quota", async () => {
    const r = await call(await sign(claims()), ["https://a.org/", "https://b.org/", "https://c.org/"]);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("full");
    expect(r.body.results["https://c.org/"]).toMatchObject({ state: "rejected", reason: "new_url_quota_exceeded" });
    expect((await store.lookup(["https://a.org/", "https://b.org/", "https://c.org/"])).size).toBe(2);
    expect(await store.newUrlsUsed("oidc:Jupyter", new Date(NOW * 1000).toISOString().slice(0, 10))).toBe(2);
  });

  it("pull_request runs are read-only: known URLs answered, nothing added", async () => {
    await call(await sign(claims()), ["https://a.org/"]);
    const r = await call(await sign(claims({ event_name: "pull_request" })), ["https://a.org/", "https://new.org/"]);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("read_only");
    expect(r.body.results["https://a.org/"].state).toBe("unknown"); // known, just not checked yet
    expect(r.body.results["https://a.org/"].reason).toBeUndefined();
    expect(r.body.results["https://new.org/"]).toMatchObject({ state: "unknown", reason: "read_only_not_queued" });
    expect((await store.lookup(["https://new.org/"])).size).toBe(0);
  });

  it("valid token from a repo not on the allowlist gets 403 with a hint", async () => {
    const r = await call(await sign(claims({ repository: "evil/x", repository_owner_id: "666" })), ["https://a.org/"]);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/evil\/x is not in the OIDC allowlist/);
  });

  it("invalid tokens get 401 and cannot reach admin routes", async () => {
    expect((await call(await sign(claims(), { key: otherKeys.privateKey }), ["https://a.org/"])).status).toBe(401);
    const { c } = cache();
    const admin = await handleRequest(
      new Request("https://proxy.test/v1/admin/stats", { headers: { authorization: `Bearer ${await sign(claims())}` } }),
      { store, cfg: DEFAULT_CONFIG, nowMs: () => NOW * 1000, oidc: { verify: (t) => verifyGithubToken(t, c.lookup, NOW), allowlist: list } },
    );
    expect(admin.status).toBe(403);
  });
});
