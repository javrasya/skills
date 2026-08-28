#!/usr/bin/env bash
set -euo pipefail

# Reports whether upstream has moved past the vendored files listed in vendor.tsv
# (ADR-0001). Vendoring makes this repo self-contained at the price of drift; this
# is what makes the drift visible instead of silent.
#
#   ./scripts/check-vendored.sh            # report only; non-zero exit if anything moved
#   ./scripts/check-vendored.sh --update   # pull upstream content and re-pin
#   ./scripts/check-vendored.sh --diff     # show what changed upstream, change nothing
#
# The pinned sha tracks UPSTREAM, not our copy. A vendored file is expected to differ
# locally — attribution headers, genericization — so comparing our copy to upstream
# would report drift forever. What matters is whether upstream has changed since we
# last looked at it.
#
# Requires the `gh` CLI, authenticated.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO/vendor.tsv"
MODE="${1:-report}"

moved=0
ok=0
tmp_manifest="$(mktemp)"
trap 'rm -f "$tmp_manifest"' EXIT

while IFS=$'\t' read -r path src upstream_path pinned || [ -n "${path:-}" ]; do
  case "$path" in ''|'#'*) printf '%s\n' "$path" >> "$tmp_manifest"; continue ;; esac

  upstream_sha="$(gh api "repos/$src/contents/$upstream_path" --jq '.sha' 2>/dev/null || echo gone)"

  if [ "$upstream_sha" = gone ]; then
    echo "UPSTREAM GONE   $path — no longer at $src/$upstream_path"
    moved=$((moved + 1))
  elif [ "$upstream_sha" != "$pinned" ]; then
    if [ "$pinned" = unreviewed ]; then
      echo "NEVER REVIEWED  $path — upstream has never been diffed against our copy"
    else
      echo "UPSTREAM MOVED  $path — $src changed since ${pinned:0:8}"
    fi
    moved=$((moved + 1))

    if [ "$MODE" = --diff ] || [ "$MODE" = --update ]; then
      up="$(mktemp)"
      gh api "repos/$src/contents/$upstream_path" --jq '.content' | base64 -d > "$up"
      if [ "$MODE" = --diff ]; then
        diff --strip-trailing-cr "$REPO/$path" "$up" | sed 's/^/    /' || true
      else
        cp "$up" "$REPO/$path"
        pinned="$upstream_sha"
        echo "  pulled and re-pinned — re-add the attribution header before committing"
      fi
      rm -f "$up"
    fi
  else
    ok=$((ok + 1))
  fi

  printf '%s\t%s\t%s\t%s\n' "$path" "$src" "$upstream_path" "$pinned" >> "$tmp_manifest"
done < "$MANIFEST"

if [ "$MODE" = --update ]; then
  cp "$tmp_manifest" "$MANIFEST"
  echo
  echo "Read the diff before committing — an upstream change is not automatically right for this repo,"
  echo "and --update overwrites local genericization and attribution headers."
fi

echo
echo "$ok in sync, $moved needing a look"
[ "$moved" -eq 0 ]
