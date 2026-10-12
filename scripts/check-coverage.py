#!/usr/bin/env python3
# Fails unless every mod has at least MIN_TESTS tests, every registered slash command is run by a test,
# and every event a mod hooks is raised by a test (through a $ call listed in RAISED_BY).
# A mod that hooks events only to observe them opts out per event with a `// coverage: observer` line.
import glob, os, re, sys

MIN_TESTS = 4
# The $ calls in a test that raise each event. Events not listed are raised by $.<event>(.
RAISED_BY = {
    'session.start': [],  # the kit starts a session for every test
    'ui.render': ['ui.mount', 'ui.render'],
    'ui.close': [],  # the test kit's $ cannot raise it (2.1.295)
    'turn.start': ['prompt.submit', 'turn.start'],
    'turn.complete': ['prompt.submit', 'turn.complete'],
    'prompt.compose': ['prompt.submit'],
    'prompt.submit': ['prompt.submit'],
    'command.run': None,  # checked per command below
}
SYNCED = re.compile(r'// <(\w+)[:>].*?// </\1>', re.S)

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
bad = 0
total = 0
for manifest in sorted(glob.glob('*/.claude-plugin/plugin.json')):
    mod = manifest.split('/')[0]
    source = ''.join(open(f).read() for f in glob.glob(f'{mod}/hooks/*.ts*'))
    own = SYNCED.sub('', source)
    tests = ''.join(open(f).read() for f in glob.glob(f'{mod}/tests/*.test.ts*'))
    n = len(re.findall(r'^\s*(?:test|it)\(', tests, re.M))
    total += n
    if n < MIN_TESTS:
        print(f'{mod}: {n} tests, needs {MIN_TESTS}'); bad = 1
    for cmd in sorted(set(re.findall(r"command\.register\(\{\s*name:\s*'([\w:-]+)'", source))):
        if not re.search(rf"command:\s*'{re.escape(cmd)}'", tests):
            print(f'{mod}: no test runs /{cmd}'); bad = 1
    if '// coverage: observer' in own:
        continue
    for event in sorted(set(re.findall(r"\bon\('([a-z.]+)'", own))):
        calls = RAISED_BY.get(event, [event])
        if calls is None or calls == []:
            continue
        if not any(f'$.{c}(' in tests for c in calls):
            print(f'{mod}: no test raises {event} (via {", ".join("$." + c for c in calls)})'); bad = 1
print(f'{total} tests')
sys.exit(bad)
