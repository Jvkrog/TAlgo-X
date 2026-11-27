#!/usr/bin/env bash
# Installs the private core modules (separate private repo) into this tree. They are git-ignored here, so a normal pull never touches them.
#   scripts/sync-core.sh [path-to-core-clone]      default: ../TAlgo-X-core  (clone it once: git clone <private repo url> ../TAlgo-X-core)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${1:-$HERE/../TAlgo-X-core}"
[ -d "$CORE/.git" ] || { echo "core repo not found at $CORE (clone it there, or pass its path)"; exit 1; }
git -C "$CORE" pull --ff-only
# validate every manifest entry first, then copy (nothing is copied if any entry is unsafe)
while IFS= read -r f; do [ -n "$f" ] || continue
  case "$f" in /*|*..*|*[[:space:]]*) echo "refusing unsafe path in MANIFEST.txt: $f"; exit 1;; esac
  case "$f" in *.js) ;; *) echo "refusing non-.js path in MANIFEST.txt: $f"; exit 1;; esac
  [ -f "$CORE/$f" ] && [ ! -L "$CORE/$f" ] || { echo "missing or symlink in core repo: $f"; exit 1; }
done < "$CORE/MANIFEST.txt"
while IFS= read -r f; do [ -n "$f" ] || continue
  mkdir -p "$HERE/$(dirname "$f")"; cp -p "$CORE/$f" "$HERE/$f"
done < "$CORE/MANIFEST.txt"
echo "core files installed into $HERE:"; sed 's/^/  /' "$CORE/MANIFEST.txt"
echo "Restart the affected engines yourself (pm2 restart <name>)."
