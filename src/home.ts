/** Human-facing landing page served at `/` to browsers. Aimed at consumers. */
import { DEFAULT_KEY_QUOTA, REPO_URL, type Config } from "./config.js";
import { DEFAULT_OIDC_QUOTA } from "./oidc.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function homePage(origin: string, cfg: Config): string {
  const o = esc(origin);
  const repo = esc(REPO_URL);
  const issue = `${repo}/issues/new?template=api-key.yml`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>link-check-proxy</title>
<meta name="description" content="A shared, polite link-status cache for CI link checkers in the Jupyter and Scientific Python ecosystem.">
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
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; padding: 3rem 16px 4rem; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  .lede { color: var(--muted); font-size: 1.1rem; margin: 0 0 2.5rem; }
  h3 { font-size: 1.02rem; margin: 1.75rem 0 .5rem; }
  ul { padding-left: 1.25rem; }
  li { margin: .3rem 0; }
  h2 { font-size: 1.2rem; margin: 2.5rem 0 .75rem; padding-top: 1.25rem; border-top: 1px solid var(--rule); }
  a { color: var(--accent); }
  code, pre { font: 0.88em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { background: var(--code-bg); padding: .1em .35em; border-radius: 4px; }
  pre { background: var(--code-bg); padding: .9rem 1rem; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: .95rem; }
  th, td { text-align: left; padding: .45rem .6rem .45rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .cta {
    display: inline-block; margin: .25rem 0 0; padding: .55rem 1rem; border-radius: 6px;
    background: var(--accent); color: var(--bg); text-decoration: none; font-weight: 600;
  }
  .note { color: var(--muted); font-size: .95rem; }
  .links { margin: -1.75rem 0 2.5rem; font-size: .95rem; }
  .callout {
    margin: 1.5rem 0; padding: .9rem 1rem; border-left: 4px solid var(--warn);
    background: var(--code-bg); border-radius: 0 6px 6px 0;
  }
  footer { margin-top: 3rem; color: var(--muted); font-size: .9rem; }
</style>
</head>
<body>
<main>
<h1>link-check-proxy</h1>
<p class="lede">A shared, polite link-status cache for CI link checkers in the Jupyter and Scientific Python ecosystem.</p>
<nav class="links"><a href="${o}/v1/snapshot.json">Public snapshot (JSON)</a> · <a href="#access">Get access</a> · <a href="${repo}">Source</a></nav>

<h2>Why</h2>
<p>Many projects run a link checker (Sphinx <code>linkcheck</code>, lychee, markdown-link-check, …) on every push and pull request. Each run hits every external URL again, and the same few sites get the same requests from dozens of projects. Those sites start rate-limiting or blocking CI, and builds turn red for reasons that have nothing to do with your change.</p>
<p>This service checks each URL <strong>once, for everyone</strong>, and spreads the checks out over time with at most one request per host per minute. Your CI asks the service instead of the web. It gets an answer right away, and the remote sites see a fraction of the traffic.</p>

<h2>How it works</h2>
<p>Send all your URLs in one request. The answer comes straight from the cache and never waits on the network. URLs the service hasn't seen before come back as <code>unknown</code> and are checked in the background over the next minutes. Results are re-checked before they expire as long as someone keeps asking for them. URLs nobody asks for are checked less and less often, and are dropped after 30 days.</p>
<pre><code>curl -s ${o}/v1/check \\
  -H "Authorization: Bearer $LCP_API_KEY" \\
  -d '{"urls": ["https://numpy.org/", "https://scipy.org/nope"]}'</code></pre>
<pre><code>{"results": {
  "https://numpy.org/": {"state": "fresh", "status": 200, "error": null,
      "final_url": "https://numpy.org/", "checked_at": "2026-11-10T08:12:03Z",
      "consecutive_failures": 0},
  "https://scipy.org/nope": {"state": "unknown", "status": null, ...}}}</code></pre>
<p class="note">Up to ${cfg.maxUrlsPerRequest} URLs per request. Fragments (<code>#anchor</code>) are ignored for now. Only public <code>http</code>/<code>https</code> URLs are accepted.</p>

<div class="callout">
  <strong>Everything you submit becomes public.</strong> Every URL sent to <code>/v1/check</code> is stored with its result and published in the <a href="#snapshot">public snapshot</a>, which anyone can download without a key. Only submit URLs that are already public, such as links from your published documentation. <strong>Never send private or internal URLs, or URLs that carry tokens, signed parameters or personal data in their path or query string.</strong>
</div>

<h2>Reading the answer</h2>
<p>The service reports what it saw. <strong>Your client decides</strong> what counts as broken. A reasonable default:</p>
<table>
  <tr><th>Result</th><th>Meaning</th><th>Suggested handling</th></tr>
  <tr><td><code>fresh</code>/<code>stale</code>, 2xx or 3xx</td><td>Worked when last checked.</td><td class="ok">Pass.</td></tr>
  <tr><td><code>fresh</code>, 404 or 410</td><td>Gone.</td><td class="bad">Fail.</td></tr>
  <tr><td>5xx, or <code>error</code> = <code>timeout</code>, <code>dns</code>, <code>connect</code>, <code>tls</code></td><td>Failing. <code>consecutive_failures</code> says for how long.</td><td class="warn">Warn. Fail only if it keeps failing (e.g. ≥ 3).</td></tr>
  <tr><td><code>error</code> = <code>challenged</code></td><td>The site served a bot challenge. It probably works in a browser.</td><td class="warn">Ignore, or check by hand.</td></tr>
  <tr><td><code>unknown</code></td><td>Not checked yet. It is queued now.</td><td class="warn">Skip, or check it yourself this once.</td></tr>
  <tr><td><code>rejected</code></td><td>Not accepted. See <code>reason</code>.</td><td>Fix the URL, or check it yourself.</td></tr>
</table>
<p class="note"><code>stale</code> means the result is older than its TTL and a re-check is already scheduled. Results last 24 h for successes and 6 h for client errors. Failures are retried with backoff, starting at 15 minutes.</p>

<h2 id="access">Getting access</h2>
<p>There are two ways in, and both are free. Either way, <strong>you agree that the URLs you submit are published</strong> (see above).</p>

<h3>On GitHub Actions: OIDC, no secret needed (recommended)</h3>
<p>Open a pull request that adds your org or repository to <a href="${repo}/blob/main/config/github-oidc.json"><code>config/github-oidc.json</code></a>. Leave the numeric id as <code>null</code>: CI looks it up and prints the value to paste in. Once it is merged and deployed, any workflow in that org or repository with <code>permissions: id-token: write</code> can authenticate with a short-lived token that GitHub mints for the job.</p>
<p><a class="cta" href="${repo}/edit/main/config/github-oidc.json">Add your org or repository</a></p>
<ul>
  <li>Runs triggered by <code>push</code>, <code>schedule</code>, <code>workflow_dispatch</code> and <code>merge_group</code> can add new URLs, up to ${DEFAULT_OIDC_QUOTA} per day unless the entry says otherwise.</li>
  <li><code>pull_request</code> runs (and any other event) are <strong>read-only</strong>. You get cached results, and unknown URLs are reported with <code>"reason": "read_only_not_queued"</code> but not added. Response <code>"mode"</code> is <code>"read_only"</code>.</li>
  <li>Pull requests from forks can't mint tokens. Use the <a href="#snapshot">public snapshot</a> there.</li>
</ul>

<h3>Elsewhere: an API key</h3>
<p>Keys are issued by hand to projects in the Jupyter and Scientific Python ecosystem. They allow ${DEFAULT_KEY_QUOTA} new URLs per day by default. To ask for one, open an issue with your project's name, its repository, and roughly how many links it checks.</p>
<p><a class="cta" href="${issue}">Request an API key</a></p>
<p class="note">The key is sent to you privately. <strong>Never paste a key into an issue, a commit or a CI log.</strong> Store it as a CI secret and send it as <code>Authorization: Bearer &lt;key&gt;</code>.</p>

<h2>Using it from GitHub Actions</h2>
<p>With OIDC, there's no secret to set up. The job mints a token, sends your URLs, and fails if any link is gone. On fork PRs, where no token is available, it skips. You could use the snapshot there instead, or your normal link check.</p>
<pre><code>jobs:
  linkcheck:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write   # lets the job mint a GitHub OIDC token
    steps:
      - uses: actions/checkout@v4
      # ... write the URLs to check to links.txt, one per line ...
      - name: Check links via link-check-proxy
        run: |
          if [ -z "\${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
            echo "No OIDC token (fork PR?): skipping"; exit 0
          fi
          TOKEN=$(curl -sf -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
            "$ACTIONS_ID_TOKEN_REQUEST_URL&amp;audience=link-check-proxy" | jq -r .value)
          jq -Rs 'split("\\n") | map(select(length > 0)) | {urls: .}' links.txt \\
            | curl -sf ${o}/v1/check -H "Authorization: Bearer $TOKEN" -d @- \\
            | jq -r '.results | to_entries[]
                     | select(.value.state == "fresh" and (.value.status == 404 or .value.status == 410))
                     | "BROKEN \\(.key)"' | tee broken.txt
          test ! -s broken.txt   # fail the job if any link is broken</code></pre>
<p class="note">Using an API key instead? Drop the token lines and send <code>Authorization: Bearer $LCP_API_KEY</code> from a secret. Plugins for Sphinx and other link checkers may come later. Until then, each project wires up the call itself.</p>

<h2 id="snapshot">Public snapshot (no key needed)</h2>
<p>Every ${cfg.maintenanceEveryMinutes} minutes, and after each deployment, the service publishes all of its results as one JSON file: <a href="${o}/v1/snapshot.json"><code>/v1/snapshot.json</code></a>. Callers without a key, such as CI on pull requests from forks, can download it and look up their URLs locally. Fetching the snapshot never adds URLs and never triggers a check. URLs that aren't in it are simply unknown, so check those yourself.</p>
<pre><code>curl -s ${o}/v1/snapshot.json</code></pre>
<pre><code>{"format": 1, "generated_at": 1762770000,
 "fields": ["status", "error", "checked_at", "expires_at", "consecutive_failures"],
 "urls": {"https://numpy.org/": [200, null, 1762760000, 1762846400, 0], ...}}</code></pre>
<p class="note">Times are epoch seconds, and a result is fresh while <code>now &lt; expires_at</code>. URL keys are normalized: fragments are removed, and scheme and host are lowercased. The response carries an <code>ETag</code>, so send <code>If-None-Match</code> to get a <code>304</code> when nothing has changed. Never-checked URLs are not included.</p>

<h2>Please be gentle</h2>
<p>Each key has a daily limit on <em>new</em> URLs. Looking up URLs the service already knows is not limited. Sending the same list on every run is fine and expected. That is how the service knows which URLs are still in use.</p>

<footer>
  Source, design notes and issues: <a href="${repo}">${repo.replace(/^https:\/\//, "")}</a> · MIT licensed
</footer>
</main>
</body>
</html>
`;
}
