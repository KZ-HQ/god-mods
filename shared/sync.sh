#!/bin/sh
# Inlines shared/metrics.ts (minus its import line) between the metrics markers in every mod's
# hooks/register.tsx. With --check, fails if any inlined copy differs instead of writing.
cd "$(dirname "$0")/.." || exit 1
exec python3 -I - "$@" <<'PY'
import glob, re, sys
src = open('shared/metrics.ts').read()
body = re.sub(r"^import type \{[^}]*\} from 'claude-code'\n", '', src, flags=re.M)
body = body.replace('export function', 'function')
block = '// <metrics: generated from shared/metrics.ts by shared/sync.sh>\n' + body.rstrip('\n') + '\n// </metrics>\n'
check = '--check' in sys.argv
bad = 0
for f in sorted(glob.glob('*/hooks/register.tsx')):
    s = open(f).read()
    m = re.search(r'// <metrics[^\n]*\n.*?// </metrics>\n', s, re.S)
    if not m:
        print('no metrics markers:', f); bad = 1; continue
    if s[m.start():m.end()] == block: continue
    if check:
        print('stale:', f); bad = 1
    else:
        open(f, 'w').write(s[:m.start()] + block + s[m.end():])
sys.exit(bad)
PY
