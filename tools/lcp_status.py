#!/usr/bin/env python3
"""Compact status view of a link-check-proxy instance, meant for `watch`.

    export ADMIN_TOKEN=...                 # admin token or an admin API key
    watch -n 30 tools/lcp_status.py        # add -c and --color for colors

Uses /v1/admin/overview, which only does cheap indexed reads. Full counts
are cached by the server and refreshed by each maintenance run.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = "https://link-check-proxy.carreau.workers.dev"


def rel(ts: int | None, now: int) -> str:
    """Human relative time: '3m ago', 'in 2h', 'never'."""
    if ts is None:
        return "never"
    d = ts - now
    a = abs(d)
    if a < 100:
        s = f"{a}s"
    elif a < 3600:
        s = f"{a // 60}m"
    elif a < 86400:
        s = f"{a // 3600}h{(a % 3600) // 60:02d}"
    else:
        s = f"{a // 86400}d{(a % 86400) // 3600:02d}h"
    if a < 5:
        return "now"
    return f"in {s}" if d > 0 else f"{s} ago"


class Style:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def _c(self, code: str, s: str) -> str:
        return f"\033[{code}m{s}\033[0m" if self.enabled else s

    def bold(self, s: str) -> str:
        return self._c("1", s)

    def dim(self, s: str) -> str:
        return self._c("2", s)

    def status(self, status: int | None, error: str | None, kind: str = "result") -> str:
        if kind == "deferred":
            return self._c("2", "defer".ljust(9))
        text = str(status) if status is not None else "-"
        if error:
            text = f"{text} {error}" if status is not None else error
        text = text[:9].ljust(9)
        if error or status is None or status >= 500 or status == 429:
            return self._c("31", text)
        if status >= 400:
            return self._c("33", text)
        if status >= 300:
            return self._c("36", text)
        return self._c("32", text)


def queue_line(data: dict) -> str:
    """Queue sizes and a rough time to drain what is due right now."""
    q = data.get("queue")
    due = data["due_now"]
    if not q:  # older server
        return f"due now {due}{'+' if data.get('due_capped') else ''}"
    cap = q["count_cap"]

    def n(v: int) -> str:
        return f"{v}+" if v >= cap else str(v)

    line = (
        f"queue: {n(q['never_checked'])} never checked "
        f"({n(q['never_checked_due'])} due now), {n(q['refresh_due'])} due for refresh"
    )
    if due:
        # Lower bound: per-host limits (1 URL/host/min) can make it slower.
        minutes = -(-due // max(1, q["checks_per_tick"]))
        line += f"; draining takes ≥{minutes}m at ≤{q['checks_per_tick']}/min"
    return line


def next_batch(data: dict) -> str:
    """When the next checking tick runs and how big it can be.

    Cron fires at the top of every minute; minutes divisible by
    maintenance_every_minutes do maintenance instead of checking.
    """
    q = data.get("queue")
    if not q:
        return ""
    now = data["now"]
    every = max(1, q.get("maintenance_every_minutes") or 60)
    at = (now // 60 + 1) * 60
    while (at // 60) % every == 0:
        at += 60
    due = data["due_now"]
    if not due:
        return f"nothing due; next tick in {at - now}s"
    size = min(due, q["checks_per_tick"])
    return f"next batch of ≤{size} in {at - now}s"


def fit(url: str, width: int) -> str:
    if width <= 1 or len(url) <= width:
        return url
    return url[: width - 1] + "…"


def render(data: dict, base_url: str, width: int, st: Style) -> str:
    now = data["now"]
    out: list[str] = []
    stamp = time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(now))
    out.append(st.bold("link-check-proxy") + f"  {base_url}  {stamp}")

    s = data.get("stats")
    if s:
        out.append(
            f"URLs {s.get('urls', 0)}  fresh {s.get('fresh', 0)}  stale {s.get('stale', 0)}  "
            f"unknown {s.get('unknown', 0)}  failing {s.get('failing', 0)}  "
            f"4xx {s.get('client_errors', 0)}  "
            + st.dim(f"(counts {rel(s.get('computed_at'), now)})")
        )
    else:
        out.append(st.dim("no cached stats yet (computed by the cron tick)"))

    out.append(queue_line(data))
    t = data.get("last_tick")
    if t:
        tick = (
            f"last tick {rel(t['at'], now)}: picked {t['picked']}, ok {t['results']}, "
            f"rate-limited {t['rateLimited']}, deferred {t['deferred']}"
        )
        if (now - t["at"]) > 180:
            tick = st._c("31", tick + "  ← cron stalled?")
    else:
        tick = st._c("33", "no tick recorded yet")
    out.append(tick)
    snap = data.get("snapshot")
    out.append(
        st.dim(f"public snapshot: {snap['urls']} URLs, {snap['bytes'] / 1e6:.1f} MB, built {rel(snap['generated_at'], now)}")
        if snap
        else st.dim("public snapshot: not built yet (rebuilt by maintenance and after each deploy; needs the SNAPSHOT KV binding)")
    )

    # Columns: 2 + 12 + 2 + 12 + 2 + 9 + 2 + url
    url_w = max(20, width - 41)

    out.append("")
    # Column headings use the same widths as the rows below them.
    out.append(st.bold("UPCOMING") + st.dim(f"  {next_batch(data)}"))
    out.append(st.dim(f"  {'next check':<12}  {'last checked':<12}  {'status':<9}  url"))
    for r in data.get("upcoming", []):
        nxt = r["next_check_at"]
        # Overdue rows say "overdue 9m", never "due 9m" (reads like "in 9m").
        when = "overdue " + rel(nxt, now).replace(" ago", "") if nxt < now - 4 else rel(nxt, now)
        out.append(
            f"  {when[:12]:<12}  {rel(r['checked_at'], now)[:12]:<12}  "
            f"{st.status(r['status'], r['error']) if r['checked_at'] else st.dim('-'.ljust(9))}  "
            f"{fit(r['url'], url_w)}"
        )
    if not data.get("upcoming"):
        out.append(st.dim("  (no URLs)"))

    out.append("")
    out.append(st.bold("RECENT"))
    out.append(st.dim(f"  {'checked':<10}  {'next check':<12}  {'status':<9}  url"))
    for r in data.get("recent", []):
        out.append(
            f"  {rel(r['at'], now)[:10]:<10}  {(rel(r['next_check_at'], now) if r['next_check_at'] else '-')[:12]:<12}  "
            f"{st.status(r['status'], r['error'], r['kind'])}  {fit(r['url'], url_w)}"
        )
    if not data.get("recent"):
        out.append(st.dim("  (nothing checked yet)"))
    return "\n".join(out)


def fetch(base_url: str, token: str, limit: int) -> dict:
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/admin/overview?limit={limit}",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "lcp-status/0.1"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default=os.environ.get("LCP_URL", DEFAULT_URL), help="service URL (env LCP_URL)")
    p.add_argument("-n", "--limit", type=int, default=None, help="rows per section (default: fit terminal)")
    p.add_argument("--color", action="store_true", help="ANSI colors (use with `watch -c`)")
    p.add_argument("--json", action="store_true", help="print the raw overview JSON")
    args = p.parse_args(argv)

    token = os.environ.get("ADMIN_TOKEN")
    if not token:
        print("ADMIN_TOKEN is not set", file=sys.stderr)
        return 2

    size = shutil.get_terminal_size((100, 40))  # honors COLUMNS/LINES set by `watch`
    # Header is 5 lines + 2x(title + headings) + 2 blank lines; split the rest.
    limit = args.limit or max(3, min(100, (size.lines - 13) // 2))

    try:
        data = fetch(args.url, token, limit)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} from {args.url}: {e.read().decode(errors='replace')[:200]}")
        return 1
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"cannot reach {args.url}: {e}")
        return 1

    if args.json:
        print(json.dumps(data, indent=2))
    else:
        print(render(data, args.url, size.columns, Style(args.color)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
