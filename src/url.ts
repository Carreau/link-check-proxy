/** URL normalization and safety checks. Pure. */

export type NormalizeResult =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: string };

export function normalizeUrl(input: unknown, maxLength: number): NormalizeResult {
  if (typeof input !== "string") return { ok: false, reason: "not_a_string" };
  if (input.length > maxLength) return { ok: false, reason: "too_long" };
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme" };
  }
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  const blocked = blockedHostReason(u.hostname);
  if (blocked) return { ok: false, reason: blocked };
  u.hash = "";
  return { ok: true, url: u.toString(), host: u.hostname };
}

/** Returns a reason string if the host must never be fetched, else null. */
export function blockedHostReason(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "" ) return "invalid_url";
  if (h === "localhost" || h.endsWith(".localhost")) return "private_address";
  if (h.startsWith("[")) {
    return isPrivateIPv6(h.slice(1, -1)) ? "private_address" : null;
  }
  const v4 = parseIPv4(h);
  if (v4) return isPrivateIPv4(v4) ? "private_address" : null;
  // Single-label names (e.g. "intranet") only make sense on private networks.
  if (!h.includes(".")) return "private_address";
  return null;
}

function parseIPv4(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isPrivateIPv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIPv6(h: string): boolean {
  const s = h.toLowerCase();
  if (s === "::" || s === "::1") return true;
  if (/^f[cd]/.test(s)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(s)) return true; // fe80::/10 link-local
  // IPv4-mapped / compatible: be conservative and block.
  if (s.startsWith("::ffff:") || /^::\d/.test(s)) return true;
  return false;
}
