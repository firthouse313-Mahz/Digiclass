#!/bin/sh
# Git doesn't version .git/hooks, so a fresh clone won't have the
# pre-commit safety check (scripts/check_integrity.py) wired up until this
# is run once. Run it after cloning:
#
#   sh scripts/install_hooks.sh
#
set -e
ROOT="$(git rev-parse --show-toplevel)"
HOOK="$ROOT/.git/hooks/pre-commit"
cat > "$HOOK" <<'EOF'
#!/bin/sh
# Auto-installed safety net -- see scripts/check_integrity.py for what this
# checks and why. Blocks the commit if src/app.js or the build is broken.
cd "$(git rev-parse --show-toplevel)" || exit 1
python3 scripts/check_integrity.py
EOF
chmod +x "$HOOK"
echo "Installed pre-commit hook at $HOOK"
