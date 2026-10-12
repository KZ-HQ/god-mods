#!/bin/sh
# Inlines each shared/<name>.ts (minus its import line) between the <name> markers in mods' hooks/register.ts[x]:
#   // <name: generated from shared/<name>.ts by shared/sync.sh> ... // </name>
# metrics is required in every register.tsx; other blocks are inlined only where their markers exist.
# With --check, fails if any inlined copy differs instead of writing.
cd "$(dirname "$0")/.." || exit 1
exec python3 -I - "$@" <<'PY'
import glob, os, re, sys
check = '--check' in sys.argv
bad = 0
blocks = {}
for path in sorted(glob.glob('shared/*.ts')):
    name = os.path.basename(path)[:-3]
    body = re.sub(r"^import type \{[^}]*\} from 'claude-code'\n", '', open(path).read(), flags=re.M)
    body = body.replace('export async function', 'async function').replace('export function', 'function')
    blocks[name] = f'// <{name}: generated from shared/{name}.ts by shared/sync.sh>\n' + body.rstrip('\n') + f'\n// </{name}>\n'
for f in sorted(glob.glob('*/hooks/register.ts') + glob.glob('*/hooks/register.tsx')):
    s = orig = open(f).read()
    for name, block in blocks.items():
        m = re.search(rf'// <{name}[:>][^\n]*\n.*?// </{name}>\n', s, re.S)
        if not m:
            if name == 'metrics' and f.endswith('.tsx'):
                print('no metrics markers:', f); bad = 1
            continue
        s = s[:m.start()] + block + s[m.end():]
    if s == orig: continue
    if check:
        print('stale:', f); bad = 1
    else:
        open(f, 'w').write(s)
sys.exit(bad)
PY
