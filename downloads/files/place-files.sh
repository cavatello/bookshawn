#!/bin/bash
# place-files.sh — put the downloaded files where they belong.
#
#   bash ~/Downloads/place-files.sh
#
# Finds your bookshawn clone, copies the nine files from ~/Downloads into the
# right subdirectories, and verifies. Safe to re-run; it overwrites in place.

set -u
DL="${DOWNLOADS:-$HOME/Downloads}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }

# ---- locate the repo -------------------------------------------------------
REPO="${1:-}"
if [ -z "$REPO" ]; then
  for c in "$HOME/bookshawn" "$PWD" "$PWD/bookshawn" "$DL/bookshawn" \
           "$HOME/Documents/bookshawn" "$HOME/Desktop/bookshawn" \
           "$HOME/Developer/bookshawn" "$HOME/code/bookshawn" \
           "$HOME/projects/bookshawn"; do
    if [ -d "$c/.git" ]; then REPO="$c"; break; fi
  done
fi
if [ -z "$REPO" ]; then
  REPO=$(find "$HOME" -maxdepth 4 -type d -name bookshawn \
         -not -path '*/Library/*' 2>/dev/null | head -1)
fi

if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
  red "Couldn't find the bookshawn repo."
  echo
  echo "Clone it first:"
  dim "  cd ~ && git clone https://github.com/cavatello/bookshawn.git"
  echo
  echo "Or pass the path directly:"
  dim "  bash ~/Downloads/place-files.sh /path/to/bookshawn"
  exit 1
fi

REPO=$(cd "$REPO" && pwd)   # absolute
echo
echo "Repo      $REPO"
echo "Downloads $DL"
echo "$(printf '%.0s-' {1..58})"

[ -d "$DL" ] || { red "No Downloads folder at $DL"; exit 1; }

mkdir -p "$REPO/worker" "$REPO/dev"

# ---- copy ------------------------------------------------------------------
# Browsers rename repeat downloads to "index (1).html", so match the newest
# file whose name starts with the stem and ends with the extension.
missing=0
place() {                       # place <filename> <destdir>
  local name="$1" dest="$2" stem ext src
  stem="${name%.*}"; ext="${name##*.}"
  src=$(ls -t "$DL/$stem"*."$ext" 2>/dev/null | head -1)
  if [ -n "$src" ] && [ -f "$src" ]; then
    cp "$src" "$REPO/$dest/$name"
    if [ "$(basename "$src")" != "$name" ]; then
      green "  ok    $dest/$name   (from '$(basename "$src")')"
    else
      green "  ok    $dest/$name"
    fi
  else
    red   "  MISS  $dest/$name"
    missing=$((missing+1))
  fi
}

place index.html      .
place SETUP.md        .
place NEXT-STEPS.md   .
place worker.js       worker
place wrangler.toml   worker
place serve.js        dev
place test-cal.js     dev
place check-google.js dev
place check-worker.js dev

# tidy this script away too, if it was downloaded alongside the rest
src=$(ls -t "$DL"/place-files*.sh 2>/dev/null | head -1)
[ -n "$src" ] && cp "$src" "$REPO/dev/place-files.sh" 2>/dev/null && \
  green "  ok    dev/place-files.sh"

echo "$(printf '%.0s-' {1..58})"

# tidy the placeholder from the first commit
if [ -f "$REPO/test" ]; then
  (cd "$REPO" && git rm --cached test >/dev/null 2>&1; rm -f test)
  dim "  removed placeholder 'test' file"
fi

if [ "$missing" -gt 0 ]; then
  echo
  red "$missing file(s) not found in $DL"
  echo "Re-download the missing ones, then run this again."
  exit 1
fi

echo
green "All nine files placed."
echo
echo "Layout now:"
(cd "$REPO" && find . -type f -not -path './.git/*' | sort | sed 's|^\./|  |')
echo
echo "Next:"
dim "  cd \"$REPO\""
dim "  node dev/check-google.js       # after setting the three env vars"
echo
