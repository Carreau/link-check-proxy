#!/usr/bin/env python3
"""Check config/github-oidc.json against the GitHub API.

For every entry, look up the org/user or repository by name and compare it
with the numeric id in the file:

- id missing (null / absent): print the value to paste in, and fail;
- id differs from the name's current id: print both (renamed? re-registered
  name?), and fail;
- name cannot be found: fail.

On failure, a corrected file is printed at the end so contributors can copy
it in one go. In GitHub Actions, errors also show up as annotations.

    python3 tools/check_allowlist.py              # uses $GITHUB_TOKEN if set
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PATH = Path(__file__).resolve().parent.parent / "config" / "github-oidc.json"
REL = "config/github-oidc.json"
IN_CI = os.environ.get("GITHUB_ACTIONS") == "true"


def gh(path: str) -> dict[str, Any] | None:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "link-check-proxy-allowlist-check"}
    if token := os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"https://api.github.com{path}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def error(msg: str) -> None:
    print(f"::error file={REL}::{msg}" if IN_CI else f"ERROR: {msg}")


def main() -> int:
    data = json.loads(PATH.read_text())
    entries = data.get("entries", [])
    ok = True
    for e in entries:
        name = e.get("name", "?")
        if "owner" in e:
            kind, login, id_key = "owner", e["owner"], "owner_id"
            found = gh(f"/users/{login}")  # works for orgs and users
        elif "repository" in e:
            kind, login, id_key = "repository", e["repository"], "repository_id"
            found = gh(f"/repos/{login}")
        else:
            error(f'entry "{name}": needs "owner" or "repository"')
            ok = False
            continue

        if found is None:
            error(f'entry "{name}": {kind} "{login}" not found on GitHub')
            ok = False
            continue

        actual = found["id"]
        current = found.get("login") or found.get("full_name")
        have = e.get(id_key)
        if have in (None, "", 0):
            error(f'entry "{name}": set "{id_key}": {actual}  ({kind} {current})')
            e[id_key] = actual
            ok = False
        elif have != actual:
            other = gh(f"/user/{have}" if kind == "owner" else f"/repositories/{have}")
            now_is = (other or {}).get("login") or (other or {}).get("full_name") or "nothing (deleted?)"
            error(
                f'entry "{name}": {id_key} {have} does not match {kind} "{login}" (id {actual}). '
                f"Id {have} currently belongs to {now_is}. If the {kind} was renamed, update the name; "
                f"if the name was re-registered by someone else, do NOT just change the id."
            )
            ok = False
        else:
            print(f'ok: "{name}" -> {kind} {current} ({actual})')

    if not ok:
        print("\nSuggested config/github-oidc.json (missing ids filled in; review mismatches by hand):\n")
        print(json.dumps(data, indent=2))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
