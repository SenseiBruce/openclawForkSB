#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$ROOT" <<'PY'
import re, sys
from pathlib import Path

root = Path(sys.argv[1])
example = (root / ".env.example").read_text(encoding="utf-8")
documented = set(re.findall(r"^([A-Z][A-Z0-9_]*)=", example, flags=re.M))
names = set()
pat = re.compile(r"process\.env\.([A-Z][A-Z0-9_]*)")
pat2 = re.compile(r"process\.env\[['\"]([A-Z][A-Z0-9_]*)['\"]\]")
for path in (root / "src").rglob("*"):
    if path.suffix not in {".ts", ".js", ".mjs", ".cjs"}:
        continue
    if "node_modules" in path.parts:
        continue
    text = path.read_text(encoding="utf-8")
    names.update(pat.findall(text))
    names.update(pat2.findall(text))
missing = sorted(names - documented)
if missing:
    print("env vars referenced in src/ but missing from .env.example:", file=sys.stderr)
    for name in missing:
        print(f"  {name}", file=sys.stderr)
    sys.exit(1)
print(f"check-env-example: {len(names)} src env vars are documented")
PY
