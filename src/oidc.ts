/**
 * GitHub Actions OIDC authentication.
 *
 * A workflow with `permissions: id-token: write` can mint a short-lived JWT
 * signed by GitHub, with claims describing the run (repository, owner, event,
 * ...). We verify it against GitHub's published keys and match the run's
 * repository / owner against the allowlist in config/github-oidc.json.
 *
 * No secret is distributed. Fork pull requests cannot mint tokens at all;
 * they use the public snapshot instead.
 */

export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const OIDC_JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;
/** Clients request tokens with `audience=link-check-proxy`. */
export const OIDC_AUDIENCE = "link-check-proxy";
/**
 * Events that may add URLs. Everything else, most importantly
 * `pull_request`, gets read-only access: cached results only, nothing
 * added, so PRs can't fill the cache or spend the quota.
 */
export const FULL_ACCESS_EVENTS = new Set(["push", "schedule", "workflow_dispatch", "merge_group"]);
const CLOCK_LEEWAY_S = 60;
export const DEFAULT_OIDC_QUOTA = 500;

export interface AllowEntry {
  name: string;
  owner?: string;
  /** null while a PR is pending: CI prints the right value. */
  owner_id?: number | null;
  repository?: string;
  repository_id?: number | null;
  new_url_quota_per_day?: number;
}
export interface Allowlist {
  entries: AllowEntry[];
}

export interface GithubClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  repository: string;
  repository_id: string;
  repository_owner: string;
  repository_owner_id: string;
  event_name: string;
  ref?: string;
  workflow_ref?: string;
}

export interface OidcGrant {
  /** Stable id for quota accounting, e.g. "oidc:Jupyter". */
  usageId: string;
  entry: AllowEntry;
  quota: number;
  readOnly: boolean;
  claims: GithubClaims;
}

// ---------- allowlist ----------

/** Returns a list of problems; empty means valid. Used by tests / CI. */
export function validateAllowlist(x: unknown): string[] {
  const errors: string[] = [];
  const entries = (x as Allowlist)?.entries;
  if (!Array.isArray(entries)) return ["top-level `entries` array is required"];
  const names = new Set<string>();
  const ids = new Set<string>();
  const isId = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  entries.forEach((e: AllowEntry, i) => {
    const where = `entries[${i}] (${e?.name ?? "?"})`;
    if (typeof e?.name !== "string" || !e.name.trim()) errors.push(`${where}: name is required`);
    else if (names.has(e.name)) errors.push(`${where}: duplicate name`);
    else names.add(e.name);
    const isOrg = e.owner !== undefined || e.owner_id != null;
    const isRepo = e.repository !== undefined || e.repository_id != null;
    if (isOrg === isRepo) {
      errors.push(`${where}: give either owner+owner_id or repository+repository_id`);
    } else if (isOrg) {
      if (typeof e.owner !== "string" || !/^[A-Za-z0-9-]+$/.test(e.owner)) errors.push(`${where}: bad owner`);
      if (!isId(e.owner_id)) errors.push(`${where}: owner_id must be GitHub's numeric id (CI's tools/check_allowlist.py prints it)`);
      if (ids.has(`o${e.owner_id}`)) errors.push(`${where}: duplicate owner_id`);
      ids.add(`o${e.owner_id}`);
    } else {
      if (typeof e.repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(e.repository)) {
        errors.push(`${where}: repository must be "owner/name"`);
      }
      if (!isId(e.repository_id)) errors.push(`${where}: repository_id must be GitHub's numeric id (CI's tools/check_allowlist.py prints it)`);
      if (ids.has(`r${e.repository_id}`)) errors.push(`${where}: duplicate repository_id`);
      ids.add(`r${e.repository_id}`);
    }
    if (e.new_url_quota_per_day !== undefined && !(Number.isInteger(e.new_url_quota_per_day) && e.new_url_quota_per_day >= 0)) {
      errors.push(`${where}: new_url_quota_per_day must be a non-negative integer`);
    }
  });
  return errors;
}

/**
 * Match verified claims against the allowlist, by numeric id only (names
 * can be renamed or re-registered by someone else). A repository entry wins
 * over its org's entry, so a repo can have its own quota.
 */
export function matchAllowlist(claims: GithubClaims, list: Allowlist): OidcGrant | null {
  const repoId = Number(claims.repository_id);
  const ownerId = Number(claims.repository_owner_id);
  const entry =
    list.entries.find((e) => typeof e.repository_id === "number" && e.repository_id === repoId) ??
    list.entries.find((e) => typeof e.owner_id === "number" && e.owner_id === ownerId);
  if (!entry) return null;
  return {
    usageId: `oidc:${entry.name}`,
    entry,
    quota: entry.new_url_quota_per_day ?? DEFAULT_OIDC_QUOTA,
    readOnly: !FULL_ACCESS_EVENTS.has(claims.event_name),
    claims,
  };
}

// ---------- JWT verification ----------

export function looksLikeJwt(token: string): boolean {
  return /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token);
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as T;
}

export type KeyLookup = (kid: string) => Promise<CryptoKey | null>;

/**
 * Verify an RS256 GitHub OIDC token. Returns its claims, or null when it is
 * not valid for us (bad signature, wrong issuer/audience, expired, ...).
 */
export async function verifyGithubToken(
  token: string,
  getKey: KeyLookup,
  nowSec: number,
  audience = OIDC_AUDIENCE,
): Promise<GithubClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: GithubClaims;
  try {
    header = b64urlJson(h);
    claims = b64urlJson(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const key = await getKey(header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  if (claims.iss !== OIDC_ISSUER) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp < nowSec - CLOCK_LEEWAY_S) return null;
  if (typeof claims.nbf === "number" && claims.nbf > nowSec + CLOCK_LEEWAY_S) return null;
  if (!claims.repository_id || !claims.repository_owner_id || !claims.event_name) return null;
  return claims;
}

/**
 * GitHub's signing keys, cached per isolate. Refetched hourly, or early
 * when an unknown key id shows up (at most once per minute, so garbage
 * tokens can't make us hammer GitHub).
 */
export class JwksCache {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = -Infinity;
  private lastMissFetch = -Infinity;

  constructor(
    private fetchFn: (url: string) => Promise<Response>,
    private nowMs: () => number = Date.now,
    private url = OIDC_JWKS_URL,
  ) {}

  lookup: KeyLookup = async (kid) => {
    const now = this.nowMs();
    if (now - this.fetchedAt > 3600_000) {
      // Counts as this minute's refetch too: no second fetch for a new kid.
      this.lastMissFetch = now;
      await this.tryRefresh();
    }
    let key = this.keys.get(kid);
    if (!key && now - this.lastMissFetch > 60_000) {
      this.lastMissFetch = now;
      await this.tryRefresh();
      key = this.keys.get(kid);
    }
    return key ?? null;
  };

  /**
   * Refresh, but keep serving the cached keys if GitHub is unreachable. With
   * no keys at all, the error propagates (callers get 401). After a failure,
   * wait 5 minutes before trying again.
   */
  private async tryRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch (e) {
      if (this.keys.size === 0) throw e;
      console.error("JWKS refresh failed; using cached keys", e);
      this.fetchedAt = this.nowMs() - 3600_000 + 300_000;
    }
  }

  private async refresh(): Promise<void> {
    const res = await this.fetchFn(this.url);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] };
    const next = new Map<string, CryptoKey>();
    for (const jwk of keys) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      const { kid, ...rest } = jwk;
      next.set(
        kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: rest.kty, n: rest.n, e: rest.e },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    }
    this.keys = next;
    this.fetchedAt = this.nowMs();
  }
}
