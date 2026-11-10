/**
 * Public snapshot of every checked URL, rebuilt hourly and served without a
 * key at /v1/snapshot.json. Lets callers without credentials (e.g. fork PRs)
 * use cached results without ever adding URLs or causing outbound fetches.
 */
import type { Store } from "./store.js";

/** Minimal blob storage (Workers KV satisfies it; tests use a Map). */
export interface BlobStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export const SNAPSHOT_KEY = "snapshot.json";
export const SNAPSHOT_FORMAT = 1;
export const SNAPSHOT_FIELDS = ["status", "error", "checked_at", "expires_at", "consecutive_failures"];

export interface SnapshotInfo {
  generated_at: number;
  urls: number;
  bytes: number;
}

/**
 * Build the snapshot JSON. SQLite renders each page of rows, so the Worker
 * only concatenates strings (cheap on CPU, which is tight on the free tier).
 */
export async function buildSnapshot(
  store: Store,
  now: number,
  pageSize = 2000,
): Promise<{ body: string; info: SnapshotInfo }> {
  const parts: string[] = [];
  let after = "";
  let count = 0;
  for (;;) {
    const page = await store.snapshotPage(after, pageSize);
    if (page.last === null) break;
    if (page.n > 0) parts.push(page.obj.slice(1, -1)); // strip { }
    count += page.n;
    after = page.last;
  }
  const header = JSON.stringify({
    format: SNAPSHOT_FORMAT,
    generated_at: now,
    fields: SNAPSHOT_FIELDS,
    note: "Times are epoch seconds. A result is fresh while now < expires_at. All URLs here are public.",
  });
  // header is `{...}`: splice the urls object in before its closing brace.
  const body = `${header.slice(0, -1)},"urls":{${parts.join(",")}}}`;
  return { body, info: { generated_at: now, urls: count, bytes: body.length } };
}

/** Pull `generated_at` out of a stored snapshot without parsing all of it. */
export function snapshotGeneratedAt(body: string): number | null {
  const m = /"generated_at":(\d+)/.exec(body.slice(0, 200));
  return m ? Number(m[1]) : null;
}
