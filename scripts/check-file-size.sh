#!/usr/bin/env bash
# Fail if tracked installer scripts exceed the 500-line reviewability budget.
# Generated protocol models (Swift/Kotlin) are excluded; historical src/ god
# files are tracked separately and are not gated here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAX=500
failed=0

check() {
  local file="$1"
  local lines
  lines="$(wc -l < "$file" | tr -d ' ')"
  if (( lines > MAX )); then
    echo "too many lines ($lines > $MAX): ${file#"$ROOT/"}" >&2
    failed=1
  fi
}

check "$ROOT/scripts/install.sh"
for file in "$ROOT"/scripts/install/*.sh "$ROOT"/scripts/check-*.sh; do
  [[ -f "$file" ]] || continue
  check "$file"
done

if (( failed )); then
  exit 1
fi
echo "check-file-size: installer and check scripts are under ${MAX} LOC"
