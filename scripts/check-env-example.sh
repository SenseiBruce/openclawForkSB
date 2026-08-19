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
required = {
    "GH_TOKEN",
    "GW_TOKEN",
    "GW_URL",
    "HOME",
    "DOCS_I18N_GLOSSARY_BASE",
    "FIRECRAWL_BASE_URL",
    "GITHUB_ACTIONS",
}
missing_required = sorted(required - documented)
if missing or missing_required:
    print("env vars missing from .env.example:", file=sys.stderr)
    for name in [*missing, *missing_required]:
        print(f"  {name}", file=sys.stderr)
    sys.exit(1)
print(f"check-env-example: {len(names)} src env vars are documented")
PY
