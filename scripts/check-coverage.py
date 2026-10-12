#!/usr/bin/env python3
# Fails unless every registered slash command is run by a test, and every mod has at least MIN_TESTS tests.
import glob, os, re, sys

MIN_TESTS = 4
os.chdir(os.path.join(os.path.dirname(__file__), '..'))
bad = 0
total = 0
for manifest in sorted(glob.glob('*/.claude-plugin/plugin.json')):
    mod = manifest.split('/')[0]
    source = ''.join(open(f).read() for f in glob.glob(f'{mod}/hooks/*.ts*'))
    tests = ''.join(open(f).read() for f in glob.glob(f'{mod}/tests/*.test.ts*'))
    n = len(re.findall(r'^\s*(?:test|it)\(', tests, re.M))
    total += n
    if n < MIN_TESTS:
        print(f'{mod}: {n} tests, needs {MIN_TESTS}'); bad = 1
    for cmd in sorted(set(re.findall(r"command\.register\(\{\s*name:\s*'([\w:-]+)'", source))):
        if not re.search(rf"command:\s*'{re.escape(cmd)}'", tests):
            print(f'{mod}: no test runs /{cmd}'); bad = 1
print(f'{total} tests')
sys.exit(bad)
