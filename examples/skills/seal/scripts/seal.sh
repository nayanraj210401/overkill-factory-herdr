#!/usr/bin/env bash
# seal.sh: lock the acceptance checks of the ticket.
#   seal.sh add <path> [path ...]   seal files (directories expand to their files); exit 1 if any path sealed nothing
#   seal.sh verify                  exit 1 if any sealed file changed or vanished
#   seal.sh list                    show sealed files
#   seal.sh reseal                  re-hash every sealed file (after an approved change)
#
# The hashes go to $SEALS (default: $FACTORY_TICKET_DIR/SEALS), the ticket
# folder, never the repo. A sealed file that changed or vanished is
# tampering or drift: report it to the person; never reseal on your own.
set -euo pipefail

seals="${SEALS:-${FACTORY_TICKET_DIR:-}/SEALS}"
[ -n "$(dirname "$seals")" ] && [ "$seals" != "/SEALS" ] || { echo "seal.sh: set SEALS or FACTORY_TICKET_DIR (the ticket folder, from the brief)" >&2; exit 2; }

sha() { shasum -a 256 <"$1" | cut -d' ' -f1; }

expand() {
  local p="${1#./}"
  if [ -d "$p" ]; then
    # git ls-files still lists files that are tracked but deleted in the working tree
    { git ls-files -- "$p"; git ls-files --others --exclude-standard -- "$p"; } | sort -u |
      while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done
  elif [ -f "$p" ]; then
    printf '%s\n' "$p"
  else
    echo "seal.sh: not found: $p" >&2; return 1
  fi
}

case "${1:-}" in
  add)
    shift; [ $# -gt 0 ] || { echo "usage: seal.sh add <path> ..." >&2; exit 2; }
    mkdir -p "$(dirname "$seals")"; touch "$seals"; rc=0
    for p in "$@"; do
      n=0
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        # hash first: a seal line is never written without one
        h="$(sha "$f")" && [ -n "$h" ] || { echo "seal.sh: cannot hash: $f" >&2; exit 1; }
        f="${f#./}"
        awk -v q="$f" 'substr($0, 67) != q' "$seals" >"$seals.tmp" && mv "$seals.tmp" "$seals"
        printf '%s  %s\n' "$h" "$f" >>"$seals"
        echo "sealed: $f"; n=$((n + 1))
      done < <(expand "$p")
      [ "$n" -gt 0 ] || rc=1
    done
    exit "$rc"
    ;;
  verify)
    [ -f "$seals" ] || { echo "no seals"; exit 0; }
    bad=0
    while read -r h f; do
      [ -n "$f" ] || continue
      if [ ! -f "$f" ]; then echo "MISSING  $f"; bad=1
      elif [ "$(sha "$f")" != "$h" ]; then echo "CHANGED  $f"; bad=1
      fi
    done <"$seals"
    [ "$bad" = 0 ] && echo "seals intact ($(wc -l <"$seals" | tr -d ' ') files)"
    exit "$bad"
    ;;
  list) [ -f "$seals" ] && awk '{print $2}' "$seals" || echo "no seals" ;;
  reseal)
    [ -f "$seals" ] || { echo "no seals"; exit 0; }
    awk '{print $2}' "$seals" >"$seals.list"
    : >"$seals"
    while IFS= read -r f; do [ -f "$f" ] && printf '%s  %s\n' "$(sha "$f")" "$f" >>"$seals"; done <"$seals.list"
    rm -f "$seals.list"
    echo "resealed"
    ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
