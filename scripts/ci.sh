#!/bin/sh
# Runs every god-mods check: validate + test each mod, shared-code sync, manifest versions + bumps, test coverage.
# Same script locally and in CI. Exits non-zero if anything fails.
cd "$(dirname "$0")/.." || exit 1
fail=0
# Base to diff against for the version-bump check: BASE_REF if set (CI), else origin/main.
base=${BASE_REF:-origin/main}
git rev-parse -q --verify "$base" >/dev/null || base=
for d in */; do
  m=${d%/}
  [ -f "$m/.claude-plugin/plugin.json" ] || continue
  claude plugin validate "$m" >/tmp/validate.$$ 2>&1 || { echo "validate FAILED: $m"; cat /tmp/validate.$$; fail=1; }
  claude plugin test "$m" >/tmp/test.$$ 2>&1 || { echo "test FAILED: $m"; cat /tmp/test.$$; fail=1; }
  pv=$(jq -r .version "$m/.claude-plugin/plugin.json")
  mv=$(jq -r --arg m "$m" '.plugins[] | select(.name == $m) | .version' .claude-plugin/marketplace.json)
  [ "$pv" = "$mv" ] || { echo "version MISMATCH: $m plugin.json=$pv marketplace.json=${mv:-missing}"; fail=1; }
  # Installs only update on a version change, so a changed mod needs a bump.
  if [ -n "$base" ] && ! git diff --quiet "$base" -- "$m"; then
    bv=$(git show "$base:$m/.claude-plugin/plugin.json" 2>/dev/null | jq -r .version)
    [ "$pv" != "$bv" ] || { echo "version NOT BUMPED: $m changed since $base but is still $pv"; fail=1; }
  fi

done
for n in $(jq -r '.plugins[].name' .claude-plugin/marketplace.json); do
  [ -d "$n" ] || { echo "marketplace lists missing mod: $n"; fail=1; }
done
sh shared/sync.sh --check || { echo "metrics sync FAILED: run sh shared/sync.sh"; fail=1; }
python3 scripts/check-coverage.py || { echo "coverage FAILED: every command needs a test, every mod 4+ tests"; fail=1; }
rm -f /tmp/validate.$$ /tmp/test.$$
[ $fail = 0 ] && echo "ALL CHECKS PASSED"
exit $fail
