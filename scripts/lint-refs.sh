#!/usr/bin/env bash
# Grep gate: the reverse-engineered reference product must never be named in this repo.
# The pattern is kept as a hex-decoded string so this script does not itself contain the word.
set -euo pipefail
cd "$(dirname "$0")/.."
PATTERN=$(printf '\x72\x69\x6c\x6c\x65\x74')
FILES=$(git ls-files 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)
HITS=$(echo "$FILES" | grep -v '^scripts/lint-refs.sh$' | xargs -I{} grep -il "$PATTERN" {} 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "lint:refs FAILED. Reference-product mention found in:" >&2
  echo "$HITS" >&2
  exit 1
fi
echo "lint:refs OK"
