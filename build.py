#!/usr/bin/env python3
"""
Builds the deployed index.html from version-controlled source.

Why this exists: before this script, every change was made by decrypting the
LIVE index.html, editing the decrypted text in a scratch file, and splicing a
freshly-encrypted blob back in. That workflow is risky (no diff/history of
the real source, no safety net) and directly caused production bugs
(blank Apps Script secrets, a JS closure bug, a stale teacher-mode check).

Now the real source lives in src/app.js (the whole app, human-readable) and
src/shell.html (everything else: <head>, CSS, the small unencrypted loader
script, and a {{DCDATA}} placeholder). This script does the one thing that
has to happen at build time: compress + encrypt src/app.js and splice it
into src/shell.html to produce index.html.

Usage:
    python3 build.py [--verify]

Requires a learn-key file (JSON with a base64 "key" field) at the path given
by the DC_LEARN_KEY_PATH environment variable, or /home/claude/dc/learn_key.json
by default. That file must NEVER be committed to this repo - it is the
encryption key that protects every teacher-only answer/notes field in
app.js's TEACH_ENC object. Keeping it outside the repo directory is what
keeps it out of git; this script does not copy it anywhere.
"""
import argparse
import base64
import gzip
import json
import os
import secrets
import subprocess
import sys
from datetime import datetime, timezone

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

REPO = os.path.dirname(os.path.abspath(__file__))
SRC_APP = os.path.join(REPO, "src", "app.js")
SRC_SHELL = os.path.join(REPO, "src", "shell.html")
OUT_HTML = os.path.join(REPO, "index.html")
LEARN_KEY_PATH = os.environ.get("DC_LEARN_KEY_PATH", "/home/claude/dc/learn_key.json")


def load_learn_key():
    if not os.path.exists(LEARN_KEY_PATH):
        sys.exit(
            f"Learn key not found at {LEARN_KEY_PATH}. "
            "Set DC_LEARN_KEY_PATH, or place learn_key.json there. "
            "This file must never live inside the repo."
        )
    data = json.load(open(LEARN_KEY_PATH))
    return base64.b64decode(data["key"])


def build(verify=False):
    if not os.path.exists(SRC_APP):
        sys.exit(f"Missing {SRC_APP} - nothing to build from.")
    if not os.path.exists(SRC_SHELL):
        sys.exit(f"Missing {SRC_SHELL} - nothing to build from.")

    app_js = open(SRC_APP, encoding="utf-8").read()
    shell = open(SRC_SHELL, encoding="utf-8").read()

    if shell.count("{{DCDATA}}") != 1:
        sys.exit(
            f"src/shell.html must contain the {{{{DCDATA}}}} placeholder exactly once, "
            f"found {shell.count('{{DCDATA}}')}."
        )
    if shell.count("{{BUILD}}") != 1:
        sys.exit(
            f"src/shell.html must contain the {{{{BUILD}}}} placeholder exactly once, "
            f"found {shell.count('{{BUILD}}')}."
        )

    # A fresh build stamp every build, so the page's own auto-update check (in
    # shell.html) can actually tell a new deploy apart from the one it already
    # has, and force a reload of any tab that's been left open since.
    build_stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    shell = shell.replace("{{BUILD}}", build_stamp)

    # Validate the source is syntactically correct JS before encrypting it.
    # This is the safety net the old workflow didn't have: a broken app.js
    # is caught here, not discovered by a teacher mid-lesson.
    check = subprocess.run(["node", "--check", SRC_APP], capture_output=True, text=True)
    if check.returncode != 0:
        sys.exit(f"src/app.js has a syntax error - build aborted:\n{check.stderr}")

    learn_key = load_learn_key()
    gz = gzip.compress(app_js.encode("utf-8"))
    iv = secrets.token_bytes(12)
    ct = AESGCM(learn_key).encrypt(iv, gz, None)
    blob = base64.b64encode(iv).decode() + "." + base64.b64encode(ct).decode()

    out_html = shell.replace("{{DCDATA}}", blob)
    open(OUT_HTML, "w", encoding="utf-8").write(out_html)
    print(f"Built {OUT_HTML} ({len(out_html)} chars) from src/app.js ({len(app_js)} chars). Build stamp: {build_stamp}")

    if verify:
        html2 = open(OUT_HTML, encoding="utf-8").read()
        i2 = html2.find('id="dcData"')
        j2 = html2.find(">", i2) + 1
        k2 = html2.find("</script>", j2)
        blob2 = html2[j2:k2].strip()
        iv2_b64, ct2_b64 = blob2.split(".")
        pt2 = gzip.decompress(
            AESGCM(learn_key).decrypt(base64.b64decode(iv2_b64), base64.b64decode(ct2_b64), None)
        ).decode("utf-8")
        assert pt2 == app_js, "Round-trip verification FAILED - built file does not decrypt back to src/app.js"
        print("Verified: index.html decrypts back to exactly src/app.js.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true", help="decrypt the built file and confirm it matches src/app.js")
    args = parser.parse_args()
    build(verify=args.verify)
