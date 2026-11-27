#!/usr/bin/env bash
# Installs the private core modules (separate private repo) into this tree. They are git-ignored here, so a normal pull never touches them.
#   scripts/sync-core.sh [path-to-core-clone]      default: ../TAlgo-X-core  (clone it once: git clone <private repo url> ../TAlgo-X-core)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${1:-$HERE/../TAlgo-X-core}"
[ -d "$CORE/.git" ] || { echo "core repo not found at $CORE (clone it there, or pass its path)"; exit 1; }
git -C "$CORE" pull --ff-only
while IFS= read -r f; do [ -n "$f" ] || continue; mkdir -p "$HERE/$(dirname "$f")"; cp -p "$CORE/$f" "$HERE/$f"; done < "$CORE/MANIFEST.txt"
echo "core files installed into $HERE:"; sed 's/^/  /' "$CORE/MANIFEST.txt"
echo "Restart the affected engines yourself (pm2 restart <name>)."
