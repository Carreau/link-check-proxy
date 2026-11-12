/**
 * Human-facing status page served at `/status` to browsers. A static shell: the
 * browser downloads the public snapshot and renders it, so the Worker does no
 * extra D1 or CPU work. Everything in the snapshot is public by design.
 */
import { REPO_URL } from "./config.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function statusPage(origin: string): string {
  const o = esc(origin);
  const repo = esc(REPO_URL);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>link-check-proxy status</title>
<meta name="description" content="Every URL link-check-proxy has checked, with its last result and when it goes stale.">
<style>
  :root {
    --bg: #fbfbf9; --fg: #1d1f21; --muted: #5d6166; --rule: #e2e2dc;
    --code-bg: #f0f0eb; --accent: #2457a6; --ok: #1f7a3a; --warn: #9a5b00; --bad: #b42318;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #16181b; --fg: #e6e6e3; --muted: #9ca1a8; --rule: #2c3036;
      --code-bg: #1f2226; --accent: #7aa7f0; --ok: #5cc27e; --warn: #e0a643; --bad: #f07a6e;
    }
  }
  :root[data-theme="dark"] {
    --bg: #16181b; --fg: #e6e6e3; --muted: #9ca1a8; --rule: #2c3036;
    --code-bg: #1f2226; --accent: #7aa7f0; --ok: #5cc27e; --warn: #e0a643; --bad: #f07a6e;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 70rem; margin: 0 auto; padding: 2rem 16px 4rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  a { color: var(--accent); }
  .meta { color: var(--muted); font-size: .95rem; margin: 0 0 1.25rem; }
  .controls { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 1rem; }
  input, select {
    font: inherit; padding: .4rem .6rem; border-radius: 6px; color: var(--fg);
    background: var(--code-bg); border: 1px solid var(--rule);
  }
  input { flex: 1 1 16rem; min-width: 0; }
  .counts { display: flex; flex-wrap: wrap; gap: .4rem 1.25rem; margin: 0 0 1rem; font-size: .95rem; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .4rem .75rem .4rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  td.url { word-break: break-all; min-width: 16rem; }
  td.when { white-space: nowrap; color: var(--muted); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  button { font: inherit; padding: .45rem .9rem; border-radius: 6px; border: 1px solid var(--rule); background: var(--code-bg); color: var(--fg); cursor: pointer; }
  #msg { color: var(--muted); margin: 1rem 0; }
  footer { margin-top: 2rem; color: var(--muted); font-size: .9rem; }
</style>
</head>
<body>
<main>
<h1>link-check-proxy status</h1>
<p class="meta" id="meta">Loading the snapshot…</p>
<p class="meta"><a href="${o}/">About</a> · <a href="${o}/v1/snapshot.json">Snapshot (JSON)</a> · <a href="${repo}">Source</a>. All URLs listed here were submitted by users and are public.</p>

<div class="controls">
  <input id="q" type="search" placeholder="Filter by URL or host" aria-label="Filter by URL or host">
  <select id="state" aria-label="Filter by result">
    <option value="">All results</option>
    <option value="ok">Working</option>
    <option value="gone">Gone (404, 410)</option>
    <option value="failing">Failing (5xx, timeouts, DNS…)</option>
    <option value="challenged">Bot challenge</option>
    <option value="other">Other 4xx</option>
    <option value="stale">Stale (past expiry)</option>
  </select>
  <select id="sort" aria-label="Sort">
    <option value="checked">Most recently checked</option>
    <option value="oldest">Least recently checked</option>
    <option value="expiry">Expires soonest</option>
    <option value="failures">Most consecutive failures</option>
    <option value="url">URL</option>
  </select>
</div>
<div class="counts" id="counts"></div>
<div class="table-wrap">
<table>
  <thead><tr><th>Result</th><th>URL</th><th>Last checked</th><th>Fresh until</th><th>Failures</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
</div>
<p id="msg"></p>
<button id="more" hidden>Show more</button>
<footer>The snapshot is rebuilt every few minutes. Times are shown in your local time zone; hover for the exact value.</footer>
</main>
<script>
(function () {
  var PAGE = 200;
  var all = [], shown = PAGE, now = Date.now() / 1000;
  var $ = function (id) { return document.getElementById(id); };

  function classify(r) {
    var s = r.status, e = r.error;
    if (e === "challenged") return "challenged";
    if (e || (s !== null && s >= 500) || r.failures > 0) return "failing";
    if (s === 404 || s === 410) return "gone";
    if (s !== null && s >= 400) return "other";
    return "ok";
  }
  function label(r) {
    return r.error ? r.error : r.status === null ? "?" : String(r.status);
  }
  function ago(t) {
    var d = now - t, a = Math.abs(d), n, u;
    if (a < 60) return "just now";
    if (a < 3600) { n = Math.round(a / 60); u = "min"; }
    else if (a < 86400) { n = Math.round(a / 3600); u = "h"; }
    else { n = Math.round(a / 86400); u = "d"; }
    return d >= 0 ? n + " " + u + " ago" : "in " + n + " " + u;
  }
  function when(t) { return new Date(t * 1000).toLocaleString(); }

  var sorters = {
    checked: function (a, b) { return b.checked - a.checked; },
    oldest: function (a, b) { return a.checked - b.checked; },
    expiry: function (a, b) { return a.expires - b.expires; },
    failures: function (a, b) { return b.failures - a.failures || b.checked - a.checked; },
    url: function (a, b) { return a.url < b.url ? -1 : a.url > b.url ? 1 : 0; }
  };

  function cell(tr, cls, text, title) {
    var td = document.createElement("td");
    if (cls) td.className = cls;
    td.textContent = text;
    if (title) td.title = title;
    tr.appendChild(td);
    return td;
  }

  function render() {
    var q = $("q").value.trim().toLowerCase(), st = $("state").value;
    var rows = all.filter(function (r) {
      if (q && r.url.toLowerCase().indexOf(q) < 0) return false;
      if (st === "stale") return r.expires <= now;
      return !st || r.kind === st;
    }).sort(sorters[$("sort").value]);

    var tb = $("rows");
    tb.textContent = "";
    rows.slice(0, shown).forEach(function (r) {
      var tr = document.createElement("tr");
      cell(tr, r.kind === "ok" ? "ok" : r.kind === "failing" || r.kind === "gone" ? "bad" : "warn", label(r));
      var td = cell(tr, "url", "");
      if (/^https?:\\/\\//i.test(r.url)) {
        var a = document.createElement("a");
        a.href = r.url; a.rel = "noopener nofollow"; a.textContent = r.url;
        td.appendChild(a);
      } else td.textContent = r.url;
      cell(tr, "when", ago(r.checked), when(r.checked));
      cell(tr, "when", r.expires > now ? ago(r.expires) : "stale since " + ago(r.expires), when(r.expires));
      cell(tr, "", r.failures ? String(r.failures) : "");
      tb.appendChild(tr);
    });
    $("msg").textContent = rows.length === 0 ? "No URLs match." :
      "Showing " + Math.min(shown, rows.length) + " of " + rows.length + " matching URLs.";
    $("more").hidden = rows.length <= shown;

    var c = { ok: 0, gone: 0, failing: 0, challenged: 0, other: 0 };
    all.forEach(function (r) { c[r.kind]++; });
    $("counts").textContent = "";
    [["ok", "working", "ok"], ["gone", "gone", "bad"], ["failing", "failing", "bad"],
     ["challenged", "bot challenge", "warn"], ["other", "other 4xx", "warn"]].forEach(function (k) {
      var s = document.createElement("span");
      s.className = k[2];
      s.textContent = c[k[0]] + " " + k[1];
      $("counts").appendChild(s);
    });
  }

  function reset() { shown = PAGE; render(); }
  $("q").addEventListener("input", reset);
  $("state").addEventListener("change", reset);
  $("sort").addEventListener("change", reset);
  $("more").addEventListener("click", function () { shown += PAGE; render(); });

  fetch("${o}/v1/snapshot.json").then(function (res) {
    if (!res.ok) throw new Error(res.status === 503 ? "The snapshot has not been generated yet. Try again in a few minutes." : "HTTP " + res.status);
    return res.json();
  }).then(function (snap) {
    now = Date.now() / 1000;
    var f = snap.fields, ix = {};
    f.forEach(function (n, i) { ix[n] = i; });
    Object.keys(snap.urls).forEach(function (u) {
      var v = snap.urls[u];
      var r = { url: u, status: v[ix.status], error: v[ix.error], checked: v[ix.checked_at],
                expires: v[ix.expires_at], failures: v[ix.consecutive_failures] };
      r.kind = classify(r);
      all.push(r);
    });
    $("meta").textContent = all.length + " URLs. Snapshot built " + ago(snap.generated_at) + " (" + when(snap.generated_at) + ").";
    render();
  }).catch(function (e) {
    $("meta").textContent = "Could not load the snapshot: " + e.message;
  });
})();
</script>
</body>
</html>
`;
}
