# talgo-shell.sh — makes `pm2 logs` show the coloured logs (logs.js) in this shell; every other pm2 command is untouched.
# Install once:   echo "source $(pwd)/talgo-shell.sh" >> ~/.bashrc   (then open a new terminal)
# Use as before:  pm2 logs   |   pm2 logs zinc   |   pm2 logs --lines 40   (--err adds stderr, --nostream prints and exits)
# Bypass it any time with:  command pm2 logs
TALGO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
pm2() {
  if [ "$1" = "logs" ]; then
    shift
    local args=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --lines) args+=("-n" "$2"); shift ;;
        --nostream) args+=("--no-follow") ;;
        --err) args+=("--err") ;;
        --raw|--json|--timestamp|--format) ;;      # not supported by the coloured viewer: ignored
        all) ;;
        -*) ;;
        *) args+=("$1") ;;
      esac
      shift
    done
    node "$TALGO_DIR/logs.js" "${args[@]}"
  else
    command pm2 "$@"
  fi
}
