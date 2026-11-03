#!/usr/bin/env python3
"""
Pre-commit safety net for DigiClass.

Why this exists: src/app.js is a single ~3.6M-char file holding the whole
app PLUS the TEACH_ENC encrypted-content blob. A single bad line-based edit
(e.g. a sed range that's off by one) can silently corrupt it in a way that
only shows up later -- or in production. This script catches that class of
bug BEFORE it reaches a commit, by actually re-deriving everything that
must stay consistent and failing loudly if it isn't.

Checks, in order (cheapest/fastest first so failures are fast):
  1. node --check on src/app.js           -- is it even valid JS?
  2. TEACH_ENC parses as JSON and every entry has both "s" and "t" payloads
     in the "z<iv-b64>.<ciphertext-b64>" shape (doesn't decrypt -- no keys
     here -- just checks the *shape* survived editing intact).
  3. COURSES / SUBJECTS arrays are present and balanced (regex sanity check,
     not a full JS parse -- catches "I deleted one closing brace too many").
  4. python3 build.py --verify            -- the real round-trip check:
     rebuilds index.html from src/app.js + src/shell.html and confirms
     decrypting it gives back EXACTLY src/app.js, byte for byte.

Usage:
    python3 scripts/check_integrity.py            # run all checks
    python3 scripts/check_integrity.py --quiet     # only print on failure

Exit code 0 = all checks passed, safe to commit/push.
Exit code 1 = something's broken -- do NOT commit.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_JS = ROOT / "src" / "app.js"
QUIET = "--quiet" in sys.argv

PAYLOAD_RE = re.compile(r"^z[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*$")


def log(msg):
    if not QUIET:
        print(msg)


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def check_node_syntax():
    log("[1/4] node --check src/app.js ...")
    r = subprocess.run(["node", "--check", str(APP_JS)], capture_output=True, text=True)
    if r.returncode != 0:
        fail(f"src/app.js has a syntax error:\n{r.stderr}")
    log("      OK")


def check_teach_enc_shape():
    log("[2/4] TEACH_ENC shape ...")
    text = APP_JS.read_text()
    m = re.search(r"const TEACH_ENC\s*=\s*(\{.*?\});", text, re.DOTALL)
    if not m:
        fail("could not find a 'const TEACH_ENC = {...};' declaration in src/app.js")
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        fail(f"TEACH_ENC does not parse as JSON ({e}). Likely a stray comma/brace from an edit.")
    if not isinstance(data, dict) or len(data) == 0:
        fail("TEACH_ENC parsed but is empty or not an object")
    bad = []
    for topic, entry in data.items():
        if not isinstance(entry, dict) or "s" not in entry or "t" not in entry:
            bad.append(f"{topic}: missing 's' or 't' key")
            continue
        for which in ("s", "t"):
            payload = entry[which]
            if not isinstance(payload, str) or not PAYLOAD_RE.match(payload):
                bad.append(f"{topic}.{which}: payload doesn't match 'z<iv>.<ciphertext>' shape")
    if bad:
        fail("TEACH_ENC has malformed entries:\n  " + "\n  ".join(bad[:20]) +
             (f"\n  ...and {len(bad) - 20} more" if len(bad) > 20 else ""))
    log(f"      OK ({len(data)} topics, all well-formed)")


def check_core_arrays():
    log("[3/4] COURSES / SUBJECTS sanity ...")
    text = APP_JS.read_text()
    if "const SUBJECTS" not in text:
        fail("const SUBJECTS declaration is missing from src/app.js")
    if "COURSES.push(" not in text and "const COURSES" not in text:
        fail("no COURSES data found in src/app.js")
    # Rough brace-balance check across the whole file -- catches a deletion
    # that removed one closing brace too many/few (what happened with the
    # sed off-by-one bug this script exists to prevent a repeat of).
    opens = text.count("{")
    closes = text.count("}")
    if opens != closes:
        fail(f"brace mismatch in src/app.js: {opens} '{{' vs {closes} '}}' "
             "-- a block was probably deleted incorrectly")
    log("      OK")


def check_build_roundtrip():
    log("[4/4] python3 build.py --verify (full rebuild + decrypt round-trip) ...")
    r = subprocess.run(["python3", "build.py", "--verify"], cwd=str(ROOT),
                        capture_output=True, text=True)
    if r.returncode != 0 or "Verified" not in r.stdout:
        fail(f"build.py --verify did not confirm a clean round-trip:\n{r.stdout}\n{r.stderr}")
    log(f"      OK -- {r.stdout.strip().splitlines()[-1]}")


def main():
    check_node_syntax()
    check_teach_enc_shape()
    check_core_arrays()
    check_build_roundtrip()
    log("\nAll integrity checks passed. Safe to commit.")
    sys.exit(0)


if __name__ == "__main__":
    main()
